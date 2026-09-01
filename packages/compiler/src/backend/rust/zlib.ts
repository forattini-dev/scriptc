import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

/** node:zlib's one-shot family → its runtime entry point (zlib.rs). Every
 * member takes one u8 Buffer and answers one, with Node's default options;
 * the decompressors throw Node's catchable Error on corrupt input. */
const ZLIB_ONE_SHOTS: Readonly<Record<string, string | undefined>> = {
  "zlib.deflateSync": "zlib_deflate_sync",
  "zlib.inflateSync": "zlib_inflate_sync",
  "zlib.gzipSync": "zlib_gzip_sync",
  "zlib.gunzipSync": "zlib_gunzip_sync",
  "zlib.unzipSync": "zlib_unzip_sync",
  "zlib.deflateRawSync": "zlib_deflate_raw_sync",
  "zlib.inflateRawSync": "zlib_inflate_raw_sync",
};

export function emitRustZlibCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const runtimeFn = ZLIB_ONE_SHOTS[expr.fn];
  if (runtimeFn === undefined) return null;
  const [data] = expr.args;
  if (expr.args.length !== 1 || data?.type.kind !== "bytes" || data.type.elem !== "u8") {
    context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  return `runtime::${runtimeFn}(&(${context.emitExpr(data)}))`;
}
