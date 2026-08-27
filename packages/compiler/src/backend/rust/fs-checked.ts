import type { IrExpr, SrcLoc } from "../../ir/nodes.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

const CHECKED_FS_CALLS = new Set([
  "fs.existsChk",
  "fs.mkdtempChk",
  "fs.mkdtempSyncChk",
  "fs.readFileChk",
  "fs.opendirChk",
  "fs.watchFileChk",
  "fs.lchmodChk",
  "fs.lchmodSyncChk",
  "fsp.lchmodChk",
  "fs.readChk",
  "fs.streamOptsChk",
]);

/** Emit the checked-dynamic filesystem validation ladders used by JavaScript sources. */
export function emitRustCheckedFsCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (!CHECKED_FS_CALLS.has(expr.fn)) return null;
  const values = expr.args.map(() => context.nextTemporary());
  const bind = bindings(expr.args, values, context);
  const value = (index: number): string => required(values, index, context, expr.loc);
  const dyn = context.dynTypeName();
  switch (expr.fn) {
    case "fs.existsChk":
      checkedShape(expr, ["dyn", "dyn"], "dyn", context);
      return `{ ${bind} ${callbackCheck(value(1), "cb")} match &${value(0)} { ${dyn}::String(sc_path) => { let sc_path = sc_path.clone(); let sc_callback = ${value(1)}.clone(); runtime::process_next_tick(Box::new(move || { let sc_answer = runtime::fs_exists(&sc_path); let _ = sc_dyn_call(&sc_callback, &[${dyn}::Boolean(sc_answer)], "the fs.exists callback"); })); ${dyn}::Undefined }, ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => { let sc_path = runtime::bytes_to_string(sc_bytes, &runtime::string("utf8")); let sc_callback = ${value(1)}.clone(); runtime::process_next_tick(Box::new(move || { let sc_answer = runtime::fs_exists(&sc_path); let _ = sc_dyn_call(&sc_callback, &[${dyn}::Boolean(sc_answer)], "the fs.exists callback"); })); ${dyn}::Undefined }, _ => { let _ = sc_dyn_call(&${value(1)}, &[${dyn}::Boolean(false)], "the fs.exists callback"); ${dyn}::Undefined }, } }`;
    case "fs.mkdtempChk":
      checkedShape(expr, ["dyn", "dyn", "string"], "dyn", context);
      return `{ ${bind} ${callbackCheck(value(1), "cb")} ${pathCheck(value(0), "prefix", dyn)} ${fence(value(2))} }`;
    case "fs.mkdtempSyncChk":
      checkedShape(expr, ["dyn", "dyn", "string"], "string", context);
      return `{ ${bind} ${pathCheck(value(0), "prefix", dyn)} ${encodingCheck(value(1), dyn, context)} ${utf8OnlyOptionsCheck(value(1), value(2), dyn, context)} match &${value(0)} { ${dyn}::String(sc_prefix) => runtime::fs_mkdtemp(sc_prefix), _ => ${fence(value(2))}, } }`;
    case "fs.readFileChk":
      checkedShape(expr, ["dyn", "dyn", "dyn", "string"], "dyn", context);
      return `{ ${bind} ${callbackCheck(value(2), "cb")} ${encodingCheck(value(1), dyn, context)} ${pathCheck(value(0), "path", dyn)} ${fence(value(3))} }`;
    case "fs.opendirChk":
      checkedShape(expr, ["dyn", "dyn", "string"], "dyn", context);
      return `{ ${bind} ${pathCheck(value(0), "path", dyn)} ${encodingCheck(value(1), dyn, context)} ${fence(value(2))} }`;
    case "fs.watchFileChk":
      checkedShape(expr, ["dyn", "dyn", "string"], "dyn", context);
      return `{ ${bind} ${pathCheck(value(0), "path", dyn)} ${callbackCheck(value(1), "listener")} ${fence(value(2))} }`;
    case "fs.lchmodChk":
      checkedShape(expr, ["dyn", "dyn", "dyn", "string"], "dyn", context);
      return `{ ${bind} if cfg!(target_os = "macos") { ${callbackCheck(value(2), "cb")} ${pathCheck(value(0), "path", dyn)} let _ = ${modeCheck(value(1), "mode", dyn, context)}; ${fence(value(3))} } else { runtime::throw_type_error("fs.lchmod is not a function".to_owned()) } }`;
    case "fs.lchmodSyncChk":
      checkedShape(expr, ["dyn", "dyn"], "dyn", context);
      return `{ ${bind} if !cfg!(target_os = "macos") { runtime::throw_type_error("fs.lchmodSync is not a function".to_owned()); } ${pathCheck(value(0), "path", dyn)} let sc_mode = ${modeCheck(value(1), "mode", dyn, context)}; let sc_path = ${pathString(value(0), dyn)}; runtime::fs_lchmod(&sc_path, sc_mode); ${dyn}::Undefined }`;
    case "fsp.lchmodChk":
      checkedShape(expr, ["dyn", "dyn"], "promise", context);
      return context.emitPromiseFromSync(expr.args, (bound) =>
        `{ if !cfg!(target_os = "macos") { runtime::throw_error_code("The lchmod() method is not implemented".to_owned(), "ERR_METHOD_NOT_IMPLEMENTED"); } ${pathCheck(bound(0), "path", dyn)} let sc_mode = ${modeCheck(bound(1), "mode", dyn, context)}; let sc_path = ${pathString(bound(0), dyn)}; runtime::fs_lchmod(&sc_path, sc_mode); () }`,
      );
    case "fs.readChk":
      checkedShape(expr, ["dyn", "dyn", "dyn", "dyn", "dyn", "string"], "dyn", context);
      return `{ ${bind} ${readChecks(values, dyn, context, expr.loc)} ${fence(value(5))} }`;
    case "fs.streamOptsChk":
      checkedShape(expr, ["dyn", "dyn", "string"], "dyn", context);
      return `{ ${bind} ${encodingCheck(value(1), dyn, context)} ${streamOptionsCheck(value(0), value(1), dyn, context)} ${fence(value(2))} }`;
  }
  return null;
}

function callbackCheck(value: string, name: string): string {
  return `if sc_dyn_function_identity(&${value}).is_none() { sc_dyn_arg_type_fail("${name}", "of type function", &${value}); }`;
}

function pathCheck(value: string, name: string, dyn: string): string {
  return `if !matches!(&${value}, ${dyn}::String(..) | ${dyn}::Bytes(..) | ${dyn}::Buffer(..)) { sc_dyn_arg_type_fail("${name}", "of type string or an instance of Buffer or URL", &${value}); }`;
}

function pathString(value: string, dyn: string): string {
  return `match &${value} { ${dyn}::String(sc_path) => sc_path.clone(), ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => runtime::bytes_to_string(sc_bytes, &runtime::string("utf8")), _ => unreachable!(), }`;
}

function encodingCheck(value: string, dyn: string, context: RustLibCallContext): string {
  const encoding = context.nextTemporary();
  return `{ let ${encoding} = match &${value} { ${dyn}::Object(..) => sc_dyn_key_get(&${value}, &runtime::string("encoding"), false), _ => ${value}.clone(), }; let sc_valid_encoding = match &${encoding} { ${dyn}::Undefined | ${dyn}::Null => true, ${dyn}::String(sc_encoding) => sc_encoding.is_empty() || runtime::buffer_is_encoding(sc_encoding), ${dyn}::Boolean(false) => true, ${dyn}::Number(sc_number) if *sc_number == 0.0 => true, _ => false, }; if !sc_valid_encoding { sc_dyn_arg_value_fail("encoding", "is invalid encoding", &${encoding}); } }`;
}

function utf8OnlyOptionsCheck(
  value: string,
  fenceValue: string,
  dyn: string,
  context: RustLibCallContext,
): string {
  const object = context.nextTemporary();
  const index = context.nextTemporary();
  const key = context.nextTemporary();
  const entry = context.nextTemporary();
  return `let sc_utf8_options = match &${value} { ${dyn}::Undefined | ${dyn}::Null => true, ${dyn}::String(sc_encoding) => matches!(sc_encoding.as_ref(), "utf8" | "utf-8"), ${dyn}::Object(${object}) => { let mut sc_utf8 = true; let mut ${index} = 0.0; while ${index} < runtime::map_iter_count(${object}) { if runtime::map_iter_live(${object}, ${index}) { let ${key} = runtime::map_iter_key(${object}, ${index}); let ${entry} = runtime::map_iter_value(${object}, ${index}); if !matches!(&${entry}, ${dyn}::Undefined | ${dyn}::Null) && (${key}.as_ref() != "encoding" || !matches!(&${entry}, ${dyn}::String(sc_encoding) if matches!(sc_encoding.as_ref(), "utf8" | "utf-8"))) { sc_utf8 = false; } } ${index} += 1.0; } sc_utf8 }, _ => false, }; if !sc_utf8_options { ${fence(fenceValue)} }`;
}

function modeCheck(
  value: string,
  name: string,
  dyn: string,
  context: RustLibCallContext,
): string {
  const rendered = context.nextTemporary();
  return `match &${value} { ${dyn}::String(sc_mode) if !sc_mode.is_empty() && sc_mode.bytes().all(|sc_byte| matches!(sc_byte, b'0'..=b'7')) => u32::from_str_radix(sc_mode, 8).unwrap_or(0) as f64, ${dyn}::String(..) => sc_dyn_arg_value_fail("${name}", "must be a 32-bit unsigned integer or an octal string", &${value}), ${dyn}::Number(sc_number) => { if !sc_number.is_finite() || sc_number.trunc() != *sc_number { let ${rendered} = runtime::format_number(*sc_number); runtime::throw_range_error_code(format!("The value of \\"${name}\\" is out of range. It must be an integer. Received {${rendered}}"), "ERR_OUT_OF_RANGE"); } if !(0.0..=4_294_967_295.0).contains(sc_number) { let ${rendered} = runtime::format_number(*sc_number); runtime::throw_range_error_code(format!("The value of \\"${name}\\" is out of range. It must be >= 0 && <= 4294967295. Received {${rendered}}"), "ERR_OUT_OF_RANGE"); } *sc_number }, sc_value => sc_dyn_arg_type_fail("${name}", "of type number", sc_value), }`;
}

function readChecks(
  values: readonly string[],
  dyn: string,
  context: RustLibCallContext,
  loc: SrcLoc,
): string {
  const fd = required(values, 0, context, loc);
  const buffer = required(values, 1, context, loc);
  const offset = required(values, 2, context, loc);
  const length = required(values, 3, context, loc);
  const position = required(values, 4, context, loc);
  const rendered = context.nextTemporary();
  return `let sc_buffer_len = match &${buffer} { ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => runtime::bytes_len(sc_bytes), sc_value => sc_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", sc_value), }; if !matches!(&${fd}, ${dyn}::Number(..)) { sc_dyn_arg_type_fail("fd", "of type number", &${fd}); } let sc_offset = match &${offset} { ${dyn}::Undefined | ${dyn}::Null => 0.0, ${dyn}::Number(sc_number) => { ${integerRange("offset", "sc_number", "0.0", "9_007_199_254_740_991.0", ">= 0 && <= 9007199254740991", rendered)} if *sc_number > sc_buffer_len { let ${rendered} = runtime::format_number(*sc_number); runtime::throw_range_error_code(format!("The value of \\"offset\\" is out of range. It must be >= 0 && <= {}. Received {${rendered}}", runtime::format_number(sc_buffer_len)), "ERR_OUT_OF_RANGE"); } *sc_number }, sc_value => sc_dyn_arg_type_fail("offset", "of type number", sc_value), }; match &${length} { ${dyn}::Undefined | ${dyn}::Null => {}, ${dyn}::Number(sc_number) => { if !sc_number.is_finite() || sc_number.trunc() != *sc_number { let ${rendered} = runtime::format_number(*sc_number); runtime::throw_range_error_code(format!("The value of \\"length\\" is out of range. It must be an integer. Received {${rendered}}"), "ERR_OUT_OF_RANGE"); } if *sc_number < 0.0 { let ${rendered} = runtime::format_number(*sc_number); runtime::throw_range_error_code(format!("The value of \\"length\\" is out of range. It must be >= 0. Received {${rendered}}"), "ERR_OUT_OF_RANGE"); } if *sc_number > sc_buffer_len - sc_offset { let ${rendered} = runtime::format_number(*sc_number); runtime::throw_range_error_code(format!("The value of \\"length\\" is out of range. It must be <= {}. Received {${rendered}}", runtime::format_number(sc_buffer_len - sc_offset)), "ERR_OUT_OF_RANGE"); } }, sc_value => sc_dyn_arg_type_fail("length", "of type number", sc_value), } match &${position} { ${dyn}::Undefined | ${dyn}::Null => {}, ${dyn}::Number(sc_number) => { ${integerRange("position", "sc_number", "-1.0", "9_007_199_254_740_991.0", ">= -1 && <= 9007199254740991", rendered)} }, sc_value => sc_dyn_arg_type_fail("position", "of type bigint or integer", sc_value), }`;
}

function streamOptionsCheck(
  path: string,
  options: string,
  dyn: string,
  context: RustLibCallContext,
): string {
  const fd = context.nextTemporary();
  const rendered = context.nextTemporary();
  return `let ${fd} = match &${options} { ${dyn}::Object(..) => sc_dyn_key_get(&${options}, &runtime::string("fd"), false), _ => ${dyn}::Undefined, }; if matches!(&${fd}, ${dyn}::Undefined | ${dyn}::Null) { ${pathCheck(path, "path", dyn)} } else { match &${fd} { ${dyn}::Number(sc_number) => { ${integerRange("fd", "sc_number", "0.0", "2_147_483_647.0", ">= 0 && <= 2147483647", rendered)} }, sc_value => sc_dyn_prop_type_fail("options.fd", "of type number or an instance of FileHandle", sc_value), } }`;
}

function integerRange(
  name: string,
  number: string,
  min: string,
  max: string,
  range: string,
  rendered: string,
): string {
  return `if !${number}.is_finite() || ${number}.trunc() != *${number} { let ${rendered} = runtime::format_number(*${number}); runtime::throw_range_error_code(format!("The value of \\"${name}\\" is out of range. It must be an integer. Received {${rendered}}"), "ERR_OUT_OF_RANGE"); } if !(${min}..=${max}).contains(${number}) { let ${rendered} = runtime::format_number(*${number}); runtime::throw_range_error_code(format!("The value of \\"${name}\\" is out of range. It must be ${range}. Received {${rendered}}"), "ERR_OUT_OF_RANGE"); }`;
}

function fence(value: string): string {
  return `runtime::throw_error_code(${value}.to_string(), "SC2020")`;
}

function bindings(
  args: readonly IrExpr[],
  values: readonly string[],
  context: RustLibCallContext,
): string {
  return args.map((arg, index) => `let ${values[index]} = ${context.emitExpr(arg)};`).join(" ");
}

function checkedShape(
  expr: RustLibCallExpr,
  args: readonly IrExpr["type"]["kind"][],
  result: IrExpr["type"]["kind"],
  context: RustLibCallContext,
): void {
  if (expr.args.length !== args.length || expr.args.some((arg, index) => arg.type.kind !== args[index]) ||
      (result === "promise" ? expr.type.kind !== "promise" : expr.type.kind !== result)) {
    context.unsupported(`${expr.fn} checked filesystem shape`, expr.loc);
  }
}

function required(
  values: readonly string[],
  index: number,
  context: RustLibCallContext,
  loc: SrcLoc,
): string {
  return values[index] ?? context.unsupported("checked filesystem temporary", loc);
}
