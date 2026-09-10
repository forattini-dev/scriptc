import * as ts from "../ts7/adapter.js";
import { UNDEFINED_T, type IrType } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** Optional destinations must observe a missing array element before any
 * argument specialization or return-value conversion can erase absence. */
export function hasOptionalIndexContext(L: Lowerer, node: ts.Expression): boolean {
  const context = L.checker.getContextualType(node);
  if (context && (context.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined)) !== 0) return true;
  const type = context ? L.mapTypeOf(context) : null;
  return type?.kind === "union" && L.armTag(type.unionId, UNDEFINED_T) >= 0;
}

/** Implicit JS specialization must not install a bare checker binding for
 * an array read lowered with an undefined arm. Keep the checked-dynamic
 * parameter in that case; a truthful optional checker type still specializes.
 * This is a type query only, so it never lowers/evaluates an argument twice. */
export function hasHiddenOptionalIndex(L: Lowerer, node: ts.Expression, mapped: IrType): boolean {
  if (mapped.kind === "union" && L.armTag(mapped.unionId, UNDEFINED_T) >= 0) return false;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isElementAccessExpression(node) || !hasOptionalIndexContext(L, node)) return false;
  return L.mapTypeOf(L.typeOf(node.expression))?.kind === "array";
}
