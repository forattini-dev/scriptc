import * as ts from "./ts7/adapter.js";

/** The one recognizer shared by preflight edges and binding provenance:
 * a bare require callee and exactly one string-literal argument. */
export function requireSpecOf(node: ts.Node): string | null {
  let value = node;
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertion(value) || ts.isNonNullExpression(value)) value = value.expression;
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== "require" || value.arguments.length !== 1) return null;
  const arg = value.arguments[0];
  return arg !== undefined && ts.isStringLiteral(arg) ? arg.text : null;
}
