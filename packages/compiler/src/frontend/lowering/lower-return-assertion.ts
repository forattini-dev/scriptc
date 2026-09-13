import * as ts from "../ts7/adapter.js";
import type { IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** A generic body's inferred return can retain an unresolved mapped alias
 * although its call signature has already supplied a concrete return slot.
 * Reuse that slot only for the exact checker return type, never an unrelated
 * assertion that happens to occur inside the same function. */
export function resolvedReturnAssertion(L: Lowerer, expr: ts.AsExpression | ts.TypeAssertion, asserted: ts.Type): IrType | null {
  if (!L.typeParamBindings || L.ctx.inferReturn) return null;
  let use: ts.Node = expr;
  while (use.parent && ts.isParenthesizedExpression(use.parent)) use = use.parent;
  if (!use.parent || !ts.isReturnStatement(use.parent) || use.parent.expression !== use) return null;
  let owner: ts.Node | undefined = use.parent;
  while (owner && !ts.isFunctionDeclaration(owner) && !ts.isFunctionExpression(owner) && !ts.isArrowFunction(owner) && !ts.isMethodDeclaration(owner)) owner = owner.parent;
  if (!owner) return null;
  const signature = L.checker.getSignatureFromDeclaration(owner);
  return signature && L.checker.getReturnTypeOfSignature(signature) === asserted ? L.ctx.returnType : null;
}
