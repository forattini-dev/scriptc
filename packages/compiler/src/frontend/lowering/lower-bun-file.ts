import * as ts from "../ts7/adapter.js";
import { STRING, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { isBunGlobalMember } from "./bun-global.js";

/** Keep the constructor's synchronous validation outside the read Promise. */
export function lowerBunFileTextCall(L: Lowerer, call: ts.CallExpression, callee: ts.Expression): IrExpr | null {
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || callee.name.text !== "text") return null;
  let receiver = callee.expression;
  while (ts.isParenthesizedExpression(receiver) || ts.isNonNullExpression(receiver)) receiver = receiver.expression;
  if (!ts.isCallExpression(receiver) || !isBunGlobalMember(L, receiver.expression, "file")) return null;
  if (call.questionDotToken || receiver.questionDotToken || call.arguments.length !== 0 ||
      receiver.arguments.length !== 1 || receiver.arguments.some(ts.isSpreadElement)) {
    L.noLowering("Bun.file(path).text() arguments", call, "one string path and no options or text arguments are supported");
  }
  const path = receiver.arguments[0];
  if (!path || L.irTypeOf(path).kind !== "string") L.noLowering("Bun.file path", receiver, "a typed string path is supported");
  const loc = locOf(call);
  const checked: IrExpr = { kind: "libCall", fn: "bun.filePath", args: [L.lowerExprExpecting(path, STRING)], type: STRING, loc: locOf(receiver) };
  return { kind: "libCall", fn: "bun.fileText", args: [checked], type: { kind: "promise", inner: STRING }, loc };
}
