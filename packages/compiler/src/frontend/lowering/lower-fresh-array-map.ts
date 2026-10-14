import * as ts from "../ts7/adapter.js";
import { typeEquals, type IrExpr, type IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Context may stop at Array.map's inferred U. Construct a fresh callback
 * result at the destination ABI only when every changed slot is a literal
 * empty never[]; existing arrays and records keep their original aliases. */
export function lowerFreshArrayMapExpecting(L: Lowerer, node: ts.Expression, expected: IrType): IrExpr | null {
  if (expected.kind !== "array") return null;
  let call = node;
  while (ts.isParenthesizedExpression(call)) call = call.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "map" || call.arguments.length !== 1 ||
      L.mapTypeOf(L.typeOf(call.expression.expression))?.kind !== "array") return null;
  const callback = call.arguments[0]!;
  if (!ts.isArrowFunction(callback) || callback.type || ts.isBlock(callback.body) ||
      callback.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  if (L.lambdaReturnOverrides.has(callback)) return null;
  let body = callback.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  const own = L.mapTypeOf(L.typeOf(body));
  if (!own || typeEquals(own, expected.elem)) return null;
  const freshEmpty = (expr: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (!ts.isArrayLiteralExpression(expr) || expr.elements.length !== 0) return false;
    const t = L.typeOf(expr);
    return L.checker.isArrayType(t) && L.checker.getTypeArguments(t as ts.TypeReference).some(a => (a.flags & ts.TypeFlags.Never) !== 0);
  };
  let literal: ts.ObjectLiteralExpression | undefined;
  if (ts.isArrayLiteralExpression(body)) {
    if (expected.elem.kind !== "array" || !freshEmpty(body)) return null;
  } else if (ts.isObjectLiteralExpression(body) && own.kind === "record" && expected.elem.kind === "record") {
    const source = L.shapes.get(own.shapeId), target = L.shapes.get(expected.elem.shapeId);
    if (!source || !target || source.tuple || target.tuple || source.indexValue || target.indexValue ||
        source.fields.length !== target.fields.length) return null;
    for (const field of target.fields) {
      const from = source.fields.find(f => f.name === field.name);
      if (!from) return null;
      if (typeEquals(from.type, field.type)) continue;
      const prop = body.properties.find(p => ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === field.name);
      if (field.type.kind !== "array" || !prop || !ts.isPropertyAssignment(prop) || !freshEmpty(prop.initializer)) return null;
    }
    literal = body;
  } else return null;
  const priorReturn = L.lambdaReturnOverrides.get(callback);
  const priorLiteral = literal && L.freshObjectLiteralTypes.get(literal);
  L.lambdaReturnOverrides.set(callback, expected.elem);
  if (literal) L.freshObjectLiteralTypes.set(literal, expected.elem);
  try { return L.coerceInto(node, L.lowerExpr(node), expected); }
  finally {
    if (priorReturn) L.lambdaReturnOverrides.set(callback, priorReturn);
    else L.lambdaReturnOverrides.delete(callback);
    if (literal) {
      if (priorLiteral) L.freshObjectLiteralTypes.set(literal, priorLiteral);
      else L.freshObjectLiteralTypes.delete(literal);
    }
  }
}
