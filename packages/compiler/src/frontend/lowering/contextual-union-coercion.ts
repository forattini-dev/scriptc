import * as ts from "../ts7/adapter.js";
import { constituentTypes } from "../ts7/checker.js";
import { isUnitType, typeEquals, type IrExpr, type IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Resolve a structurally ambiguous width conversion using TS's literal
 * discriminants, which IR primitive types erase. Approval selects an arm;
 * the existing width plan must still implement its runtime conversion. */
export function contextualUnionCoercion(
  lowerer: Lowerer, node: ts.Node, expr: IrExpr, expected: IrType,
): IrExpr | null {
  if (expected.kind !== "union" || (expr.type.kind !== "record" && expr.type.kind !== "array")) return null;
  const checker = lowerer.checker;
  const contextual = checker.getContextualType(node);
  if (!contextual?.isUnionType()) return null;
  const contextIr = lowerer.mapTypeOf(contextual);
  if (contextIr === null || !typeEquals(contextIr, expected)) return null;
  const source = lowerer.typeOf(node);
  if (source.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return null;
  const candidates = new Map<number, IrType>();
  for (const arm of constituentTypes(contextual)) {
    if (!checker.isTypeAssignableTo(source, arm)) continue;
    const mapped = lowerer.mapTypeOf(arm);
    if (mapped === null || isUnitType(mapped)) return null;
    const tag = lowerer.armTag(expected.unionId, mapped);
    if (tag < 0 || lowerer.widthLiftPlan(expr.type, mapped) === null) return null;
    candidates.set(tag, mapped);
  }
  if (candidates.size !== 1) return null;
  const [tag, arm] = candidates.entries().next().value!;
  const value = lowerer.coerceToExpected(expr, arm);
  if (!typeEquals(value.type, arm)) return null;
  return { kind: "unionWrap", unionId: expected.unionId, tag, value, type: expected, loc: expr.loc };
}
