import type { IrType } from "../../ir/ir.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

/** node:zlib's one-shot family → its runtime entry point (zlib.rs). Every
 * member takes one u8 Buffer and answers one, with Node's default options;
 * the decompressors throw Node's catchable Error on corrupt input. */
const ZLIB_ONE_SHOTS: Readonly<Record<string, string | undefined>> = {
  "zlib.deflateSync": "zlib_deflate_sync",
  "zlib.deflateSyncLevel": "zlib_deflate_sync_level",
  "zlib.inflateSync": "zlib_inflate_sync",
  "zlib.gzipSync": "zlib_gzip_sync",
  "zlib.gunzipSync": "zlib_gunzip_sync",
  "zlib.unzipSync": "zlib_unzip_sync",
  "zlib.deflateRawSync": "zlib_deflate_raw_sync",
  "zlib.inflateRawSync": "zlib_inflate_raw_sync",
};

const ZLIB_CALLBACKS: Readonly<Record<string, { mode: number; compressing: boolean } | undefined>> = {
  "zlib.deflateCb": { mode: 0, compressing: true },
  "zlib.inflateCb": { mode: 0, compressing: false },
  "zlib.deflateRawCb": { mode: 1, compressing: true },
  "zlib.inflateRawCb": { mode: 1, compressing: false },
  "zlib.gzipCb": { mode: 2, compressing: true },
  "zlib.gunzipCb": { mode: 2, compressing: false },
  "zlib.unzipCb": { mode: 3, compressing: false },
};

export function emitRustZlibCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const runtimeFn = ZLIB_ONE_SHOTS[expr.fn];
  const [data, level] = expr.args;
  if (expr.fn === "zlib.deflateRawAsync" || expr.fn === "zlib.inflateRawAsync") {
    const compressing = expr.fn === "zlib.deflateRawAsync";
    if (expr.args.length !== (compressing ? 2 : 1) || (compressing && level?.type.kind !== "dyn") || data?.type.kind !== "bytes" || data.type.elem !== "u8" ||
        expr.type.kind !== "promise" || expr.type.inner.kind !== "bytes" || expr.type.inner.elem !== "u8") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    if (!compressing || !level) return `runtime::zlib_raw_promise(&(${context.emitExpr(data)}), false)`;
    const input = context.nextTemporary();
    const option = context.nextTemporary();
    const promise = context.nextTemporary();
    const guard = context.nextTemporary();
    const dyn = context.dynTypeName();
    return `{ let ${input} = ${context.emitExpr(data)}; let ${option} = ${context.emitExpr(level)}; let ${promise} = runtime::promise_new(); let ${guard} = ${promise}.clone(); runtime::promise_run_segment(&${guard}, || { let sc_level = match &${option} { ${dyn}::Undefined => -1.0, ${dyn}::Number(sc_number) => *sc_number, sc_value => sc_dyn_prop_type_fail("options.level", "of type number", sc_value), }; runtime::zlib_raw_promise_start(&${promise}, &${input}, true, sc_level); }); ${promise} }`;
  }
  if (runtimeFn !== undefined) {
    const explicitLevel = expr.fn === "zlib.deflateSyncLevel";
    if (explicitLevel && level?.type.kind !== "f64") context.unsupported("deflate level shape", expr.loc);
    if (expr.args.length !== (explicitLevel ? 2 : 1) || data?.type.kind !== "bytes" || data.type.elem !== "u8") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    return `runtime::${runtimeFn}(&(${context.emitExpr(data)})${explicitLevel && level ? `, ${context.emitExpr(level)}` : ""})`;
  }
  if (expr.fn === "zlib.crc32") {
    if (expr.args.length !== 2 || data?.type.kind !== "bytes" || data.type.elem !== "u8" || level?.type.kind !== "f64") {
      context.unsupported("zlib.crc32 shape", expr.loc);
    }
    return `runtime::zlib_crc32(&(${context.emitExpr(data)}), ${context.emitExpr(level)})`;
  }
  const callback = ZLIB_CALLBACKS[expr.fn];
  if (callback === undefined) return null;
  return emitZlibCallback(expr, callback.mode, callback.compressing, context);
}

function emitZlibCallback(
  expr: RustLibCallExpr,
  mode: number,
  compressing: boolean,
  context: RustLibCallContext,
): string {
  const [dataExpr, callbackExpr] = expr.args;
  if (expr.args.length !== 2 || dataExpr?.type.kind !== "bytes" || dataExpr.type.elem !== "u8" ||
      callbackExpr?.type.kind !== "func" || callbackExpr.type.params.length > 2 ||
      callbackExpr.type.ret.kind !== "void" || expr.type.kind !== "void") {
    context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const callbackType = callbackExpr.type;
  const args: string[] = [];
  const errorType = callbackType.params[0];
  if (errorType !== undefined) args.push(zlibErrorArgument(errorType, context, expr));
  const valueType = callbackType.params[1];
  if (valueType !== undefined) args.push(zlibValueArgument(valueType, context, expr));
  const data = context.nextTemporary();
  const callbackValue = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callbackValue, callbackType, args, expr.loc);
  return `{ let ${data} = ${context.emitExpr(dataExpr)}; let ${callbackValue} = ${context.emitExpr(callbackExpr)}; runtime::zlib_codec_async(&${data}, ${mode}_u8, ${compressing}, Box::new(move |sc_error, sc_value| { let _ = ${dispatch}; })); }`;
}

function zlibErrorArgument(
  type: IrType,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
): string {
  if (type.kind === "dyn") {
    const dyn = context.dynTypeName();
    const error = context.hasErrorClassRoots()
      ? `${context.errorValueName()}::Builtin(sc_error.clone())`
      : "sc_error.clone()";
    return `match &sc_error { Some(sc_error) => { let sc_error = ${error}; sc_dyn_error_box(&sc_error) }, None => ${dyn}::Null, }`;
  }
  if (type.kind !== "union") context.unsupported("zlib callback error parameter", expr.loc);
  const union = context.union(type.unionId, expr.loc);
  const errorTag = union.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error");
  const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
  if (errorTag < 0 || nullTag < 0) context.unsupported("zlib callback Error | null union", expr.loc);
  const payload = context.hasErrorClassRoots()
    ? `${context.errorValueName()}::Builtin(sc_error.clone())`
    : "sc_error.clone()";
  const name = context.unionName(union.id);
  return `match &sc_error { Some(sc_error) => ${name}::${context.unionVariant(errorTag)}(${payload}), None => ${name}::${context.unionVariant(nullTag)}, }`;
}

function zlibValueArgument(
  type: IrType,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
): string {
  if (type.kind === "dyn") {
    const value = context.emitDynFromValue({ kind: "bytes", elem: "u8" }, "sc_value.clone().expect(\"scriptc: zlib success without a Buffer\")", expr.loc);
    return `match &sc_value { Some(..) => ${value}, None => ${context.dynTypeName()}::Undefined, }`;
  }
  if (type.kind !== "bytes" || type.elem !== "u8") context.unsupported("zlib callback result parameter", expr.loc);
  return "sc_value.clone().unwrap_or_else(runtime::bytes_empty::<u8>)";
}
