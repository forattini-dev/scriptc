import * as ts from "../ts7/adapter.js";
import { STRING, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { lowerUrlStaticCall } from "./lower-url.js";

/** Native globals must be recognized before generic namespace dispatch,
 * while retaining declaration provenance for shadowed user bindings. */
export function lowerNativeGlobalCall(lowerer: Lowerer, call: ts.CallExpression, callee: ts.Expression): IrExpr | null {
  const url = lowerUrlStaticCall(lowerer, call, callee);
  if (url) return url;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
  if (callee.name.text !== "randomUUID" || !lowerer.isStdlibGlobal(callee.expression, "crypto")) return null;
  if (call.arguments.length !== 0) {
    lowerer.noLowering("crypto.randomUUID with arguments", call, "the supported WebCrypto call takes no arguments");
  }
  return { kind: "libCall", fn: "crypto.randomUUID", args: [], type: STRING, loc: locOf(call) };
}
