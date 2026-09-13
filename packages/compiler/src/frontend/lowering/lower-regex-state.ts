import { DYN, F64, STRING, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isRegexCaptureRead } from "./lower-regex-captures.js";

/** A JS variable assigned by exec may retain dynamic storage. Reading one
 * capture preserves undefined without validating/copying the whole array. */
export function lowerDynamicRegexCapture(L: Lowerer, node: ts.ElementAccessExpression, receiver: IrExpr): IrExpr | null {
  if (!L.statefulRegex || receiver.type.kind !== "dyn" || !isRegexCaptureRead(L, node)) return null;
  const index = L.lowerExpr(node.argumentExpression);
  if (index.type.kind !== "f64" && index.type.kind !== "string") return null;
  const key: IrExpr = index.type.kind === "string" ? index : { kind: "toString", operand: index, type: STRING, loc: index.loc };
  return { kind: "dynKeyGet", value: receiver, key, type: DYN, loc: locOf(node) };
}

export function lowerRegexStateRead(L: Lowerer, node: ts.PropertyAccessExpression): IrExpr | null {
  if (!L.statefulRegex || node.questionDotToken || !L.isStdlibMember(node)) return null;
  const type = L.checker.getNonNullableType(L.typeOf(node.expression));
  const loc = locOf(node);
  if (node.name.text === "lastIndex" && L.mapTypeOf(type)?.kind === "regex") {
    return { kind: "regexIntrinsic", method: "lastIndex", receiver: L.lowerExpr(node.expression), args: [], type: F64, loc };
  }
  const symbol = type.getSymbol();
  if ((node.name.text !== "index" && node.name.text !== "input") ||
      (symbol?.name !== "RegExpExecArray" && symbol?.name !== "RegExpMatchArray")) return null;
  const receiver = L.lowerExpr(node.expression);
  return { kind: "dynKeyGet", value: receiver.type.kind === "dyn" ? receiver : { kind: "dynFrom", value: receiver, type: DYN, loc },
    key: { kind: "strLit", value: node.name.text, type: STRING, loc }, type: DYN, loc };
}

export function lowerRegexStateAssign(L: Lowerer, node: ts.BinaryExpression): IrExpr | null {
  const left = node.left;
  if (!L.statefulRegex || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(left) || left.questionDotToken || left.name.text !== "lastIndex" ||
      !L.isStdlibMember(left) || L.mapTypeOf(L.typeOf(left.expression))?.kind !== "regex") return null;
  return { kind: "regexIntrinsic", method: "setLastIndex", receiver: L.lowerExpr(left.expression),
    args: [L.lowerExprExpecting(node.right, F64)], type: F64, loc: locOf(node) };
}
