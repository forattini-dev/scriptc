import * as ts from "../ts7/adapter.js";
export { lowerArrayElementReceiver } from "./lower-array-element-receiver.js";

/** Arithmetic must receive the optional value before ToNumber turns absence into NaN. */
export function numericReadObservesAbsence(node: ts.Node): boolean {
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.PlusToken || parent.operator === ts.SyntaxKind.MinusToken || parent.operator === ts.SyntaxKind.TildeToken;
  return ts.isBinaryExpression(parent) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken,
    ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken].includes(parent.operatorToken.kind);
}
