import * as ts from "../ts7/adapter.js";
import { typeEquals, type IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** A side-effect-free nullish constant, checked by binding identity.
 * A local variable merely named undefined cannot establish this fact. */
export function nullishConstantKind(L: Lowerer, node: ts.Node): "nullT" | "undefinedT" | null {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (node.kind === ts.SyntaxKind.NullKeyword) return "nullT";
  if (!ts.isIdentifier(node) || node.text !== "undefined" ||
      (L.typeOf(node).flags & ts.TypeFlags.Undefined) === 0) return null;
  const symbol = L.checker.getSymbolAtLocation(node);
  // The checker intrinsic has no declarations; library declarations are
  // also safe. User declarations do not prove the runtime value.
  return symbol !== undefined && (L.checker.declarationsOf(symbol).length === 0 || L.isStdlibSymbol(symbol))
    ? "undefinedT" : null;
}

/** Prove a written nullish predicate from its comparison, not its annotation.
 * Parentheses and operand order do not change the proof; a shadowed name does. */
export function provesWrittenNullishFilter(
  L: Lowerer,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  source: IrType,
  output: IrType,
): boolean {
  const parameter = callback.parameters[0];
  if (source.kind !== "union" || callback.parameters.length !== 1 || !parameter ||
      parameter.initializer || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return false;
  const stripParens = (node: ts.Node): ts.Node => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  let body: ts.Node = callback.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return false;
    const statement = body.statements[0];
    if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false;
    body = statement.expression;
  }
  body = stripParens(body);
  if (!ts.isBinaryExpression(body)) return false;
  const strict = body.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!strict && body.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken) return false;
  const left = stripParens(body.left), right = stripParens(body.right);
  const leftKind = nullishConstantKind(L, left);
  const excluded = leftKind ?? nullishConstantKind(L, right);
  const value = leftKind !== null ? right : left;
  if (excluded === null || !ts.isIdentifier(value)) return false;
  const symbol = L.checker.getSymbolAtLocation(parameter.name);
  if (symbol === undefined || L.checker.getSymbolAtLocation(value) !== symbol) return false;
  const arms = L.unions.get(source.unionId)?.arms;
  return arms !== undefined && arms.every((arm) =>
    typeEquals(arm, output) || arm.kind === excluded ||
    (!strict && (arm.kind === "nullT" || arm.kind === "undefinedT")));
}
