import * as ts from "../ts7/adapter.js";
import { F64, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { nodeThrowExpr, type Lowerer } from "./lowerer.js";

/** An erased non-null assertion must not turn a builtin call into a method value. */
export function lowerAssertedProcessIdentityCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
  let callee = call.expression;
  while (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (callee === call.expression || !ts.isPropertyAccessExpression(callee)) return null;
  const member = L.stdlibGlobalMember(callee, "process");
  if (member !== "getuid" && member !== "getgid") return null;
  if (call.arguments.length) L.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
  const loc = locOf(call);
  if (L.targetPlatform === "win32") return call.questionDotToken
    ? L.wrappedUndefined(L.withUndefinedArm(F64), loc)!
    : nodeThrowExpr(1, "", `process.${member} is not a function`, F64, loc);
  return { kind: "libCall", fn: member === "getuid" ? "process.getuid" : "process.getgid", args: [], type: F64, loc };
}
