import * as ts from "../ts7/adapter.js";
import { BYTES_U8, DYN, STRING, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { bufEncoding } from "./containers/bytes.js";

/** Retain the checked native value instead of demanding a statically known
 * string before Buffer.from can dispatch by its runtime kind. */
export function lowerDynamicBufferFrom(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const [input, encoding] = call.arguments;
  if (!input || call.arguments.length > 2 || call.arguments.some(ts.isSpreadElement)) return null;
  const type = lowerer.typeOf(input);
  if (lowerer.mapTypeOf(type)?.kind !== "dyn" && !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return null;
  const loc = locOf(call);
  const name = encoding ? bufEncoding(lowerer, "Buffer.from", encoding) : "utf8";
  return {
    kind: "libCall", fn: "buffer.fromDyn",
    args: [lowerer.lowerExprExpecting(input, DYN), { kind: "strLit", value: name, type: STRING, loc }],
    type: BYTES_U8, loc,
  };
}
