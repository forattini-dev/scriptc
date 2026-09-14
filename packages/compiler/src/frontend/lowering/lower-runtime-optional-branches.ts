import * as ts from "../ts7/adapter.js";
import type { IrLocal } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { runtimeOptionalLocalOf } from "./lower-exprs.js";

/** The runtime-optional locals a condition proves DEFINED on its FALSE branch — `x === undefined`, `x == null`, `!x`,
 * and `||` chains of those: the false-branch twin of runtimeOptionalTrueIds (`task === undefined ? "missing" :
 * Effect.runSync(task)`). */
export function runtimeOptionalFalseIds(lowerer: Lowerer, node: ts.Expression): IrLocal[] {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...runtimeOptionalFalseIds(lowerer, expr.left), ...runtimeOptionalFalseIds(lowerer, expr.right)];
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const local = runtimeOptionalLocalOf(lowerer, expr.operand);
    return local === null ? [] : [local];
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
  ) {
    const loose = expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
    const nullish = (value: ts.Expression): boolean =>
      (ts.isIdentifier(value) && value.text === "undefined" && (lowerer.typeOf(value).flags & ts.TypeFlags.Undefined) !== 0) ||
      (loose && value.kind === ts.SyntaxKind.NullKeyword);
    const binding = nullish(expr.right) ? expr.left : nullish(expr.left) ? expr.right : null;
    const local = binding === null ? null : runtimeOptionalLocalOf(lowerer, binding);
    return local === null ? [] : [local];
  }
  return [];
}
