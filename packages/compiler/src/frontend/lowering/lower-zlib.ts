import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { BYTES_U8, F64, type IrExpr } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** The fixed-level deflate option used by deterministic PNG encoders.
 * The admitted levels are stored, default and best compression. zlib-rs
 * uses different algorithms for fast/intermediate levels (level 1 already
 * differs on short repeated text), so those need their own compatibility work. */
export function lowerDeflateLevel(L: Lowerer, call: ts.CallExpression): IrExpr {
  const options = call.arguments[1]!;
  if (!ts.isObjectLiteralExpression(options) || options.properties.length !== 1) {
    L.noLowering("deflateSync options", options, "supported: { level: -1 | 0 | 9 }");
  }
  const property = options.properties[0]!;
  if (!ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) || property.name.text !== "level") {
    L.noLowering("deflateSync options", options, "supported: { level: -1 | 0 | 9 }");
  }
  const levelType = L.typeOf(property.initializer);
  if (!levelType.isNumberLiteralType() || ![-1, 0, 9].includes(levelType.value)) {
    L.noLowering("deflateSync compression level", property.initializer, "native fixed levels currently cover -1 (default), 0 (stored), and 9 (best); fast/intermediate byte compatibility is not implemented");
  }
  return { kind: "libCall", fn: "zlib.deflateSyncLevel", args: [
    L.lowerExprExpecting(call.arguments[0]!, BYTES_U8), L.lowerExprExpecting(property.initializer, F64),
  ], type: BYTES_U8, loc: locOf(call) };
}
