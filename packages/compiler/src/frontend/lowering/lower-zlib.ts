import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { InternalCompilerError } from "../../errors.js";
import { BYTES_U8, DYN, F64, STRING, VOID, funcOf, type IrExpr, type IrLibFn, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { voidizedCallback } from "./lower-server.js";

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
    zlibInputBytes(L, call.arguments[0]!, locOf(call)), L.lowerExprExpecting(property.initializer, F64),
  ], type: BYTES_U8, loc: locOf(call) };
}

const ZLIB_SYNC_FNS: Readonly<Record<string, IrLibFn | undefined>> = {
  deflateSync: "zlib.deflateSync",
  inflateSync: "zlib.inflateSync",
  deflateRawSync: "zlib.deflateRawSync",
  inflateRawSync: "zlib.inflateRawSync",
  gzipSync: "zlib.gzipSync",
  gunzipSync: "zlib.gunzipSync",
  unzipSync: "zlib.unzipSync",
};

const ZLIB_CALLBACK_FNS: Readonly<Record<string, IrLibFn | undefined>> = {
  deflate: "zlib.deflateCb",
  inflate: "zlib.inflateCb",
  deflateRaw: "zlib.deflateRawCb",
  inflateRaw: "zlib.inflateRawCb",
  gzip: "zlib.gzipCb",
  gunzip: "zlib.gunzipCb",
  unzip: "zlib.unzipCb",
};

export function zlibInputBytes(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "bytes" && value.type.elem === "u8") return value;
  if (value.type.kind === "string") {
    return {
      kind: "libCall",
      fn: "buffer.fromStr",
      args: [value, { kind: "strLit", value: "utf8", type: STRING, loc }],
      type: BYTES_U8,
      loc,
    };
  }
  lowerer.noLowering(
    `zlib byte input of '${lowerer.fmt(value.type)}' values`,
    node,
    "string and Buffer/Uint8Array values are supported",
  );
}

function errorFirstBytesCallback(lowerer: Lowerer, node: ts.Expression): IrExpr {
  let callback = lowerer.lowerExpr(node);
  if (callback.type.kind === "dyn") {
    callback = { kind: "dynCheck", value: callback, type: funcOf([DYN, DYN], VOID), loc: locOf(node) };
  }
  if (callback.type.kind !== "func" || callback.type.params.length > 2) {
    lowerer.unsupported("SC1090", node, "zlib callbacks must accept at most (error, buffer)");
  }
  const error = callback.type.params[0];
  if (error !== undefined && error.kind !== "dyn") {
    if (error.kind !== "union") {
      lowerer.unsupported("SC1090", node, "zlib callback error parameters must be Error | null");
    }
    const def = lowerer.unions.get(error.unionId);
    const valid = !!def &&
      def.arms.some((arm) => arm.kind === "nullT") &&
      def.arms.some((arm) => arm.kind === "object" && arm.className === "%Error") &&
      def.arms.every((arm) => arm.kind === "nullT" || arm.kind === "undefinedT" ||
        (arm.kind === "object" && arm.className === "%Error"));
    if (!valid) lowerer.unsupported("SC1090", node, "zlib callback error parameters must be Error | null");
  }
  const value = callback.type.params[1];
  if (value !== undefined && value.kind !== "dyn" && !(value.kind === "bytes" && value.elem === "u8")) {
    lowerer.unsupported("SC1090", node, "zlib callback result parameters must be Buffer/Uint8Array values");
  }
  return voidizedCallback(lowerer, callback, locOf(node));
}

/** Lower node:zlib's default-options one-shot family. This shared frontend
 * normalization is consumed by the Rust backend; C/LLVM remain upstream-owned. */
export function lowerZlibModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering(`zlib.${member} with spread arguments`, expr);
  }
  const syncFn = ZLIB_SYNC_FNS[member];
  if (syncFn !== undefined) {
    // The fixed-level deflate form is the one explicit-options shape with a
    // byte-compatible native path. It has to be decided here: this function
    // is the zlib entry point, so a later dispatch never sees the call.
    if (member === "deflateSync" && expr.arguments.length === 2) return lowerDeflateLevel(lowerer, expr);
    if (expr.arguments.length !== 1) {
      lowerer.noLowering(
        `${member} with explicit options`,
        expr.arguments[1] ?? expr,
        `${member}(data) with Node's default options is supported`,
      );
    }
    return {
      kind: "libCall",
      fn: syncFn,
      args: [zlibInputBytes(lowerer, expr.arguments[0]!, loc)],
      type: BYTES_U8,
      loc,
    };
  }
  const callbackFn = ZLIB_CALLBACK_FNS[member];
  if (callbackFn !== undefined) {
    if (expr.arguments.length !== 2) {
      lowerer.noLowering(
        `${member} with ${expr.arguments.length} arguments`,
        expr.arguments.length >= 3 ? expr.arguments[1]! : expr,
        `${member}(data, callback) with Node's default options is supported; explicit options are not yet lowered`,
      );
    }
    return {
      kind: "libCall",
      fn: callbackFn,
      args: [
        zlibInputBytes(lowerer, expr.arguments[0]!, loc),
        errorFirstBytesCallback(lowerer, expr.arguments[1]!),
      ],
      type: VOID,
      loc,
    };
  }
  if (member === "crc32") {
    if (expr.arguments.length < 1 || expr.arguments.length > 2) {
      lowerer.noLowering(
        `zlib.crc32 with ${expr.arguments.length} arguments`,
        expr,
        "crc32(data[, initialValue]) is supported",
      );
    }
    return {
      kind: "libCall",
      fn: "zlib.crc32",
      args: [
        zlibInputBytes(lowerer, expr.arguments[0]!, loc),
        expr.arguments[1]
          ? lowerer.lowerExprExpecting(expr.arguments[1], F64)
          : { kind: "numLit", value: 0, type: F64, loc },
      ],
      type: F64,
      loc,
    };
  }
  throw new InternalCompilerError(`unhandled lowered zlib member ${member}`);
}
