import * as ts from "../ts7/adapter.js";
import { BYTES_U8, F64, STRING, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { isBunGlobalMember } from "./bun-global.js";

/** Validation belongs to the call, after both argument expressions run. */
export function lowerBunWriteCall(L: Lowerer, call: ts.CallExpression, callee: ts.Expression): IrExpr | null {
  if (!isBunGlobalMember(L, callee, "write")) return null;
  if (call.questionDotToken || call.arguments.length !== 2 || call.arguments.some(ts.isSpreadElement)) {
    L.noLowering("Bun.write arguments", call, "one typed string path and string or Uint8Array data, without options, are supported");
  }
  const path = call.arguments[0], data = call.arguments[1];
  if (!path || !data || L.irTypeOf(path).kind !== "string") L.noLowering("Bun.write path", call, "a typed string path is supported");
  const type = L.irTypeOf(data);
  const bytes = type.kind === "bytes" && type.elem === "u8";
  if (type.kind !== "string" && !bytes) L.noLowering("Bun.write data", data, "a typed string or Uint8Array is supported");
  return {
    kind: "libCall", fn: bytes ? "bun.writeBytes" : "bun.writeText",
    args: [L.lowerExprExpecting(path, STRING), L.lowerExprExpecting(data, bytes ? BYTES_U8 : STRING)],
    type: { kind: "promise", inner: F64 }, loc: locOf(call),
  };
}
