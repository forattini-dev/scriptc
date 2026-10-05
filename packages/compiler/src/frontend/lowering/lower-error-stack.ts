import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { STRING, UNDEFINED_T, type IrExpr } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { lowerInstanceConstructorId } from "./lower-instance-constructor-name.js";

function declaresStack(node: ts.ClassDeclaration | ts.ClassExpression | null): boolean {
  return node?.members.some(member => (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
    !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
    ((ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === "stack")) ?? false;
}

function builtinError(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const type = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (type?.kind !== "object" || (!lowerer.classes.get(type.className)?.builtinError && !lowerer.isSubclassOf(type.className, "%Error"))) return null;
  for (const info of lowerer.classes.values()) {
    if (!lowerer.isSubclassOf(info.def.name, "%Error")) continue;
    if (declaresStack(info.decl)) lowerer.unsupported("SC1090", node, "shadowed Error stack property");
  }
  return lowerer.upcastTo(lowerer.lowerExpr(node), "%Error");
}

export function lowerErrorStackCall(lowerer: Lowerer, call: ts.CallExpression, member: ts.PropertyAccessExpression): IrExpr | null {
  if (lowerer.dynamic) return null;
  if (member.name.text !== "captureStackTrace" || !lowerer.isStdlibGlobal(member.expression, "Error")) return null;
  if ((call.arguments.length !== 1 && call.arguments.length !== 2) || call.arguments.some(ts.isSpreadElement)) return null;
  const node = call.arguments[0];
  if (!node) return null;
  const target = builtinError(lowerer, node);
  if (!target) return null;
  const exclude = call.arguments[1];
  if (exclude) {
    const identity = ts.isPropertyAccessExpression(exclude) ? lowerInstanceConstructorId(lowerer, exclude) : null;
    if (identity) return { kind: "libCall", fn: "error.captureStackTraceExclude", args: [target, identity], type: UNDEFINED_T, loc: locOf(call) };
    const sig = ts.isIdentifier(exclude) ? lowerer.fnSigOf(exclude) : null;
    if (!sig) return null;
    return { kind: "libCall", fn: "error.captureStackTraceExclude", args: [target, { kind: "strLit", value: sig.name, type: STRING, loc: locOf(exclude) }], type: UNDEFINED_T, loc: locOf(call) };
  }
  return { kind: "libCall", fn: "error.captureStackTrace", args: [target], type: UNDEFINED_T, loc: locOf(call) };
}

export function lowerErrorStackRead(lowerer: Lowerer, member: ts.PropertyAccessExpression): IrExpr | null {
  if (lowerer.dynamic || member.name.text !== "stack" || member.questionDotToken) return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(member.expression));
  for (let info = type?.kind === "object" ? lowerer.classes.get(type.className) : undefined; info; info = info.base ?? undefined) {
    if (declaresStack(info.decl)) return null;
  }
  const target = builtinError(lowerer, member.expression);
  if (!target) return null;
  return { kind: "libCall", fn: "error.stack", args: [target], type: STRING, loc: locOf(member) };
}
