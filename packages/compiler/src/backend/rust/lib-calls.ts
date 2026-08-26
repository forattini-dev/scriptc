import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_ERROR_CLASSES } from "../../ir/nodes.js";
import { emitRustDynamicLibCall } from "./lib-calls-dynamic.js";
import { emitRustChildProcessCall } from "./child-process.js";

export type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;
type IrFuncType = Extract<IrType, { kind: "func" }>;

const RUST_UNARY_MATH_METHODS: Readonly<Record<string, string | undefined>> = {
  "math.sqrt": "sqrt",
  "math.log2": "log2",
  "math.log10": "log10",
  "math.exp": "exp",
  "math.log": "ln",
  "math.cbrt": "cbrt",
  "math.sin": "sin",
  "math.cos": "cos",
  "math.tan": "tan",
  "math.asin": "asin",
  "math.acos": "acos",
  "math.atan": "atan",
};

const RUST_BINARY_MATH_METHODS: Readonly<Record<string, string | undefined>> = {
  "math.hypot": "hypot",
  "math.atan2": "atan2",
};

export interface RustLibCallContext {
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  unsupported(kind: string, loc?: SrcLoc): never;
  dynTypeName(): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  stripCasts(expr: IrExpr): IrExpr;
  hasClassMeta(name: string): boolean;
  classFieldName(className: string, fieldName: string, loc?: SrcLoc): string;
  hasErrorClassRoots(): boolean;
  errorValueName(): string;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  emitPromiseFromSync(
    args: readonly IrExpr[],
    operation: (value: (index: number) => string) => string,
  ): string;
  emitFileHandleTransferPromise(expr: RustLibCallExpr): string;
  emitFsRenameCallback(expr: RustLibCallExpr): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  functionIdentity(value: string, type: IrFuncType, loc: SrcLoc, borrowed?: boolean): string;
  emitEventEmitterCall(expr: RustLibCallExpr): string | null;
  classNameArms(className: string, loc?: SrcLoc): string;
}

export function emitRustLibCall(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const eventEmitterCall = context.emitEventEmitterCall(expr);
  if (eventEmitterCall !== null) return eventEmitterCall;
  const dynamicCall = emitRustDynamicLibCall(expr, context);
  if (dynamicCall !== null) return dynamicCall;
  const childProcessCall = emitRustChildProcessCall(expr, context);
  if (childProcessCall !== null) return childProcessCall;
  const arg = expr.args[0];
  const secondArg = expr.args[1];
  const thirdArg = expr.args[2];
  if (expr.fn === "string.raw" && expr.args.length === 2 &&
    arg?.type.kind === "array" && arg.type.elem.kind === "string" &&
    secondArg?.type.kind === "array" && secondArg.type.elem.kind === "string") {
    const raw = context.nextTemporary();
    const substitutions = context.nextTemporary();
    return `{ let ${raw} = ${context.emitExpr(arg)}; let ${substitutions} = ${context.emitExpr(secondArg)}; runtime::string_raw(&${raw}, &${substitutions}) }`;
  }
  if (expr.fn === "global.undefRead" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::throw_undefined_global::<${context.rustType(expr.type, expr.loc)}>(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "error.nodeThrow" && expr.args.length === 3 &&
    arg?.type.kind === "f64" && secondArg?.type.kind === "string" && thirdArg?.type.kind === "string") {
    const kind = context.nextTemporary();
    const code = context.nextTemporary();
    const message = context.nextTemporary();
    return `{ let ${kind} = ${context.emitExpr(arg)}; let ${code} = ${context.emitExpr(secondArg)}; let ${message} = ${context.emitExpr(thirdArg)}; runtime::throw_node_coded(${kind}, &${code}, &${message}) }`;
  }
  if (expr.fn === "process.exit" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::process_exit(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "process.kill" && expr.args.length === 2 &&
      arg?.type.kind === "f64" && secondArg?.type.kind === "string") {
    return `runtime::process_kill_named(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "process.killNum" && expr.args.length === 2 &&
      arg?.type.kind === "f64" && secondArg?.type.kind === "f64") {
    return `runtime::process_kill_num(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "process.isTTY" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::process_is_tty(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "process.stdinDestroy" && expr.args.length === 0) {
    return "runtime::process_stdin_destroy()";
  }
  if (expr.fn === "net.getAutoSelTimeout" && expr.args.length === 0 && expr.type.kind === "f64") {
    return "runtime::net_get_auto_select_family_attempt_timeout()";
  }
  if (expr.fn === "net.setAutoSelTimeout" && expr.args.length === 1 &&
    arg?.type.kind === "f64" && expr.type.kind === "void") {
    return `runtime::net_set_auto_select_family_attempt_timeout(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "insp.f64" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::inspect_number(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "insp.str" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::inspect_string(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "insp.key" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::inspect_key(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "insp.regex" && expr.args.length === 1 && arg?.type.kind === "regex") {
    return `runtime::inspect_regex(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "insp.buffer" && expr.args.length === 1 &&
    arg?.type.kind === "bytes" && arg.type.elem === "u8") {
    return `runtime::inspect_buffer(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "insp.begin" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::inspect_begin(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "insp.circCheck" && expr.args.length === 1 && arg !== undefined) {
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; runtime::inspect_circular_check(${value}.identity()) }`;
  }
  if (expr.fn === "insp.seenPush" && expr.args.length === 1 && arg !== undefined) {
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; runtime::inspect_seen_push(${value}.identity()) }`;
  }
  if (expr.fn === "insp.refWrap" && expr.args.length === 2 && arg !== undefined &&
    secondArg?.type.kind === "string") {
    const value = context.nextTemporary();
    const rendered = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; let ${rendered} = ${context.emitExpr(secondArg)}; runtime::inspect_ref_wrap(${value}.identity(), &${rendered}) }`;
  }
  if (expr.fn === "insp.circular" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::inspect_circular(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "insp.entry" && expr.args.length === 2 &&
    arg?.type.kind === "string" && secondArg?.type.kind === "bool") {
    return `runtime::inspect_entry(&(${context.emitExpr(arg)}), ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "insp.moreItems" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::inspect_more_items(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "insp.end" && expr.args.length === 6 &&
    arg?.type.kind === "string" && secondArg?.type.kind === "string" &&
    expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "f64" &&
    expr.args[4]?.type.kind === "bool" && expr.args[5]?.type.kind === "bool") {
    return `runtime::inspect_end(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}), &(${context.emitExpr(expr.args[2])}), ${context.emitExpr(expr.args[3])}, ${context.emitExpr(expr.args[4])}, ${context.emitExpr(expr.args[5])})`;
  }
  if (expr.fn === "insp.dyn" && expr.args.length === 3 && arg?.type.kind === "dyn") {
    const recurse = expr.args[1];
    const depth = expr.args[2];
    if (recurse === undefined || depth === undefined) context.unsupported("dynamic inspect arguments", expr.loc);
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; sc_dyn_inspect(&${value}, ${context.emitExpr(recurse)}, ${context.emitExpr(depth)}) }`;
  }
  if (expr.fn === "insp.dynS" && expr.args.length === 2 && arg?.type.kind === "dyn") {
    const depth = expr.args[1];
    if (depth === undefined) context.unsupported("dynamic string inspection depth", expr.loc);
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; sc_dyn_inspect_s(&${value}, ${context.emitExpr(depth)}) }`;
  }
  if (expr.fn === "json.parse" && expr.args.length === 1 && arg?.type.kind === "string" && expr.type.kind === "dyn") {
    return `runtime::json_parse_typed::<${context.dynTypeName()}>(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "math.floor" && expr.args.length === 1 && arg !== undefined) {
    return `(${context.emitExpr(arg)}).floor()`;
  }
  if (expr.fn === "math.abs" && expr.args.length === 1 && arg !== undefined) {
    return `(${context.emitExpr(arg)}).abs()`;
  }
  if (expr.fn === "math.round" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::math_round(${context.emitExpr(arg)})`;
  }
  if ((expr.fn === "math.trunc" || expr.fn === "math.ceil") && expr.args.length === 1 && arg !== undefined) {
    return `(${context.emitExpr(arg)}).${expr.fn === "math.trunc" ? "trunc" : "ceil"}()`;
  }
  if ((expr.fn === "math.max" || expr.fn === "math.min") && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `runtime::${expr.fn === "math.max" ? "math_max" : "math_min"}(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if ((expr.fn === "math.maxArr" || expr.fn === "math.minArr") && expr.args.length === 1 && arg?.type.kind === "array" && arg.type.elem.kind === "f64") {
    return `runtime::${expr.fn === "math.maxArr" ? "math_max_array" : "math_min_array"}(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "math.random" && expr.args.length === 0) return "runtime::math_random()";
  if (expr.fn === "math.sign" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::math_sign(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "math.pow" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `runtime::math_pow(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  const unaryMathMethod = RUST_UNARY_MATH_METHODS[expr.fn];
  if (unaryMathMethod !== undefined && expr.args.length === 1 && arg !== undefined) {
    return `(${context.emitExpr(arg)}).${unaryMathMethod}()`;
  }
  const binaryMathMethod = RUST_BINARY_MATH_METHODS[expr.fn];
  if (binaryMathMethod !== undefined && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `(${context.emitExpr(arg)}).${binaryMathMethod}(${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "regex.new" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    const pattern = context.nextTemporary();
    const flags = context.nextTemporary();
    return `{ let ${pattern} = ${context.emitExpr(arg)}; let ${flags} = ${context.emitExpr(secondArg)}; runtime::regex_new(&${pattern}, &${flags}) }`;
  }
  if (expr.fn === "regexp.escape" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::regexp_escape(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "str.encodeUriComponent" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::string_encode_uri_component(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "str.encodeUri" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::string_encode_uri(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "str.decodeUriComponent" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::string_decode_uri_component(&(${context.emitExpr(arg)}))`;
  }
  if ((expr.fn === "str.atob" || expr.fn === "str.btoa") && expr.args.length === 1 && arg?.type.kind === "dyn") {
    const value = context.nextTemporary();
    const helper = expr.fn === "str.atob" ? "string_atob" : "string_btoa";
    return `{ let ${value} = ${context.emitExpr(arg)}; runtime::${helper}(&sc_dyn_to_string(&${value})) }`;
  }
  if (expr.fn === "str.b64Missing" && expr.args.length === 0) {
    return "runtime::string_base64_missing_argument()";
  }
  if (expr.fn === "sym.new" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::symbol_new(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "sym.newAnon" && expr.args.length === 0) {
    return "runtime::symbol_new_anonymous()";
  }
  if (expr.fn === "sym.for" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::symbol_for(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "sym.toString" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::symbol_to_string(&(${context.emitExpr(arg)}))`;
  }
  if ((expr.fn === "sym.desc" || expr.fn === "sym.keyFor") &&
    expr.args.length === 1 && arg !== undefined) {
    if (expr.type.kind !== "union") context.unsupported(`${expr.fn} without an optional result union`, expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (stringTag < 0 || undefinedTag < 0) context.unsupported(`${expr.fn} result union shape`, expr.loc);
    const name = context.unionName(union.id);
    const helper = expr.fn === "sym.desc" ? "symbol_description" : "symbol_key_for";
    return `match runtime::${helper}(&(${context.emitExpr(arg)})) { Some(value) => ${name}::${context.unionVariant(stringTag)}(value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if (expr.fn === "process.argv" && expr.args.length === 0) return "runtime::process_argv()";
  if (expr.fn === "process.platform" && expr.args.length === 0) return "runtime::process_platform()";
  if (expr.fn === "process.cwd" && expr.args.length === 0) return "runtime::process_cwd()";
  if (expr.fn === "process.pid" && expr.args.length === 0) return "runtime::process_pid()";
  if (expr.fn === "process.getuid" && expr.args.length === 0) return "runtime::process_getuid()";
  if (expr.fn === "process.getgid" && expr.args.length === 0) return "runtime::process_getgid()";
  if (expr.fn === "process.execPath" && expr.args.length === 0) return "runtime::process_exec_path()";
  if (expr.fn === "process.arch" && expr.args.length === 0) return "runtime::process_arch()";
  if (expr.fn === "process.versionsNode" && expr.args.length === 0) return "runtime::process_versions_node()";
  if (expr.fn === "process.versionsOpenssl" && expr.args.length === 0) return "runtime::process_versions_openssl()";
  if (expr.fn === "process.envGet" && expr.args.length === 1 && arg !== undefined) {
    if (expr.type.kind !== "union") context.unsupported("process.envGet without an optional result union", expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (stringTag < 0 || undefinedTag < 0) context.unsupported("process.envGet result union shape", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::process_env_get(&(${context.emitExpr(arg)})) { Some(value) => ${name}::${context.unionVariant(stringTag)}(value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if (expr.fn === "process.envSet" && expr.args.length === 2 &&
    arg?.type.kind === "string" && secondArg?.type.kind === "string") {
    return `runtime::process_env_set(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "process.envUnset" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::process_env_unset(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "process.envPairs" && expr.args.length === 0 &&
    expr.type.kind === "array" && expr.type.elem.kind === "string") {
    return "runtime::process_env_pairs()";
  }
  if ((expr.fn === "process.stdoutWriteBytes" || expr.fn === "process.stderrWriteBytes") &&
    expr.args.length === 2 && arg?.type.kind === "bytes" && arg.type.elem === "u8" &&
    secondArg?.type.kind === "string") {
    const target = expr.fn === "process.stdoutWriteBytes" ? "stdout" : "stderr";
    return `runtime::process_${target}_write_bytes(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}))`;
  }
  if ((expr.fn === "process.stdoutWrite" || expr.fn === "process.stderrWrite") &&
    expr.args.length === 1 && arg?.type.kind === "string") {
    const target = expr.fn === "process.stdoutWrite" ? "stdout" : "stderr";
    return `runtime::process_${target}_write(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "num.fromString" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::number_from_string(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "num.parseInt" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::number_parse_int(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "num.parseFloat" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::number_parse_float(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "string.lastIndexOf" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `runtime::string_last_index_of(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "string.fromCharCode" && expr.args.length === 1 && arg !== undefined) {
    if (arg.type.kind === "array" && arg.type.elem.kind === "f64") {
      return `runtime::string_from_char_codes(&(${context.emitExpr(arg)}))`;
    }
    if (arg.type.kind === "bytes") {
      return `runtime::string_from_char_code_bytes(&(${context.emitExpr(arg)}))`;
    }
    context.unsupported("String.fromCharCode source type", expr.loc);
  }
  if ((expr.fn === "num.isNaN" || expr.fn === "number.isNaN") && expr.args.length === 1 && arg !== undefined) {
    return `(${context.emitExpr(arg)}).is_nan()`;
  }
  if (expr.fn === "number.isFinite" && expr.args.length === 1 && arg !== undefined) {
    return `(${context.emitExpr(arg)}).is_finite()`;
  }
  if ((expr.fn === "number.isInteger" || expr.fn === "number.isSafeInteger") && expr.args.length === 1 && arg !== undefined) {
    return `runtime::${expr.fn === "number.isInteger" ? "number_is_integer" : "number_is_safe_integer"}(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "num.toFixed0" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::number_to_fixed_default(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "num.toExponential" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::number_to_exponential(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "num.toFixed" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `runtime::number_to_fixed(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "num.toPrecision" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `runtime::number_to_precision(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "num.toRadixString" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `runtime::number_to_radix_string(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "num.sameValue" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    return `runtime::number_same_value(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "intl.numFormatEnUs" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::intl_number_format_en_us(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "error.toString" && expr.args.length === 1 && arg !== undefined) {
    const receiverExpr = context.stripCasts(arg);
    if (receiverExpr.type.kind === "object" && context.hasClassMeta(receiverExpr.type.className)) {
      const receiver = context.nextTemporary();
      const nameField = context.classFieldName(receiverExpr.type.className, "name", expr.loc);
      const messageField = context.classFieldName(receiverExpr.type.className, "message", expr.loc);
      return `{ let ${receiver} = ${context.emitExpr(receiverExpr)}; ${receiver}.with(|object| runtime::error_to_string_parts(object.${nameField}.as_ref(), object.${messageField}.as_ref())) }`;
    }
    if (context.hasErrorClassRoots()) {
      return `sc_error_to_string(&(${context.emitExpr(arg)}))`;
    }
    return `runtime::error_to_string(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "error.code" && expr.args.length === 1 && arg !== undefined) {
    if (expr.type.kind !== "union") context.unsupported("error.code without an optional result union", expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (stringTag < 0 || undefinedTag < 0) context.unsupported("error.code result union shape", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::error_code(&(${context.emitExpr(arg)})) { Some(value) => ${name}::${context.unionVariant(stringTag)}(value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if (expr.fn === "fs.readFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    const path = context.nextTemporary();
    return `{ let ${path} = ${context.emitExpr(arg)}; let _ = ${context.emitExpr(expr.args[1])}; runtime::fs_read_file(&${path}) }`;
  }
  if ((expr.fn === "fs.readFileSyncBuf" || expr.fn === "fs.readFileSyncBytes") && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_read_file_bytes(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.readFdSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_read_fd(${context.emitExpr(arg)}, &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fs.readFdSyncBytes" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_read_fd_bytes(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "fs.writeFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_write_file(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fs.writeFileSyncBytes" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_write_file_bytes(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fsp.readFileBytes" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::fs_read_file_bytes(&${value(0)})`);
  }
  if (expr.fn === "fsp.readFile" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `{ let _ = ${value(1)}; runtime::fs_read_file(&${value(0)}) }`,
    );
  }
  if (expr.fn === "fsp.writeFile" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `runtime::fs_write_file(&${value(0)}, &${value(1)})`,
    );
  }
  if (expr.fn === "fsp.writeFileMode" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1], expr.args[2]],
      (value) => `runtime::fs_write_file_mode(&${value(0)}, &${value(1)}, ${value(2)})`,
    );
  }
  if (expr.fn === "fsp.mkdir" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::fs_mkdir(&${value(0)})`);
  }
  if (expr.fn === "fsp.mkdirMode" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `runtime::fs_mkdir_mode(&${value(0)}, ${value(1)}, false)`,
    );
  }
  if (expr.fn === "fsp.mkdirRecursive" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::fs_mkdir_recursive(&${value(0)})`);
  }
  if (expr.fn === "fsp.mkdirRecursiveMode" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `runtime::fs_mkdir_mode(&${value(0)}, ${value(1)}, true)`,
    );
  }
  if (expr.fn === "fsp.unlink" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::fs_unlink(&${value(0)})`);
  }
  if (expr.fn === "fsp.chmod" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `runtime::fs_chmod(&${value(0)}, ${value(1)})`,
    );
  }
  if (expr.fn === "fsp.rename" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `runtime::fs_rename(&${value(0)}, &${value(1)})`,
    );
  }
  if (expr.fn === "fsp.readdir" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::fs_readdir(&${value(0)})`);
  }
  if (expr.fn === "fsp.rm" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::fs_rm(&${value(0)})`);
  }
  if (expr.fn === "fsp.stat" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::fs_stat(&${value(0)}, true)`);
  }
  if (expr.fn === "fsp.open" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1], expr.args[2]],
      (value) => `runtime::file_handle_open(&${value(0)}, &${value(1)}, ${value(2)})`,
    );
  }
  if (expr.fn === "fileHandle.fd" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::file_handle_fd(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fileHandle.close" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::file_handle_close(&${value(0)})`);
  }
  if (expr.fn === "fileHandle.read" || expr.fn === "fileHandle.writeBytes" || expr.fn === "fileHandle.writeStr") {
    return context.emitFileHandleTransferPromise(expr);
  }
  if (expr.fn === "fileHandle.readFile" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `runtime::file_handle_read_file(&${value(0)}, &${value(1)})`,
    );
  }
  if (expr.fn === "fileHandle.readFileBytes" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1]],
      (value) => `runtime::file_handle_read_file_bytes(&${value(0)}, &${value(1)})`,
    );
  }
  if (expr.fn === "fileHandle.writeFile" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1], expr.args[2]],
      (value) => `runtime::file_handle_write_file(&${value(0)}, &${value(1)}, &${value(2)})`,
    );
  }
  if (expr.fn === "fileHandle.writeFileBytes" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return context.emitPromiseFromSync(
      [arg, expr.args[1], expr.args[2]],
      (value) => `runtime::file_handle_write_file_bytes(&${value(0)}, &${value(1)}, &${value(2)})`,
    );
  }
  if (expr.fn === "fileHandle.stat" && expr.args.length === 1 && arg !== undefined) {
    return context.emitPromiseFromSync([arg], (value) => `runtime::file_handle_stat(&${value(0)})`);
  }
  if (expr.fn === "fs.appendFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_append_file(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fs.existsSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_exists(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.mkdirSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_mkdir(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.rmSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_rm(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.rmdirSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_rmdir(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.readdirSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_readdir(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.realpathSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_realpath(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "os.homedir" && expr.args.length === 0) return "runtime::os_homedir()";
  if (expr.fn === "os.tmpdir" && expr.args.length === 0) return "runtime::os_tmpdir()";
  if (expr.fn === "os.userName" && expr.args.length === 0) return "runtime::os_user_name()";
  if (expr.fn === "os.userShell" && expr.args.length === 0) return "runtime::os_user_shell()";
  if (expr.fn === "os.userHomedir" && expr.args.length === 0) return "runtime::os_user_homedir()";
  if (expr.fn === "os.type" && expr.args.length === 0) return "runtime::os_type()";
  if (expr.fn === "os.release" && expr.args.length === 0) return "runtime::os_release()";
  if (expr.fn === "os.totalmem" && expr.args.length === 0) return "runtime::os_totalmem()";
  if (expr.fn === "crypto.randomUUID" && expr.args.length === 0) return "runtime::crypto_random_uuid()";
  if (expr.fn === "crypto.randomBytes" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::crypto_random_bytes(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "crypto.randomBytesToString" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::crypto_random_string(${context.emitExpr(arg)}, &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fs.mkdtempSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_mkdtemp(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.mkdirRecursiveSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_mkdir_recursive(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.rmOptsSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return `runtime::fs_rm_options(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])}, ${context.emitExpr(expr.args[2])})`;
  }
  if (expr.fn === "fs.rmRetrySync" && expr.args.length === 5 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    const maxRetriesArg = expr.args[3];
    const retryDelayArg = expr.args[4];
    if (maxRetriesArg === undefined || retryDelayArg === undefined) context.unsupported("fs.rmRetrySync arguments", expr.loc);
    const path = context.nextTemporary();
    const recursive = context.nextTemporary();
    const force = context.nextTemporary();
    return `{ let ${path} = ${context.emitExpr(arg)}; let ${recursive} = ${context.emitExpr(expr.args[1])}; let ${force} = ${context.emitExpr(expr.args[2])}; let _ = ${context.emitExpr(maxRetriesArg)}; let _ = ${context.emitExpr(retryDelayArg)}; runtime::fs_rm_options(&${path}, ${recursive}, ${force}) }`;
  }
  if (expr.fn === "fs.unlinkSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_unlink(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "fs.copyFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_copy_file(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fs.renameSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_rename(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fs.renameCb") {
    return context.emitFsRenameCallback(expr);
  }
  if (expr.fn === "fs.chmodSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_chmod(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "fs.chownSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return `runtime::fs_chown(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])}, ${context.emitExpr(expr.args[2])})`;
  }
  if (expr.fn === "fs.writeFileModeSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return `runtime::fs_write_file_mode(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}), ${context.emitExpr(expr.args[2])})`;
  }
  if ((expr.fn === "fs.mkdirModeSync" || expr.fn === "fs.mkdirRecursiveModeSync") && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_mkdir_mode(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])}, ${expr.fn === "fs.mkdirRecursiveModeSync"})`;
  }
  if (expr.fn === "fs.accessSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_access(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "fs.openSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::fs_open(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "fs.closeSync" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_close(${context.emitExpr(arg)})`;
  }
  if ((expr.fn === "fs.readSync" || expr.fn === "fs.writeSync") && expr.args.length === 5 && arg !== undefined) {
    const bytes = expr.args[1];
    const offset = expr.args[2];
    const length = expr.args[3];
    const position = expr.args[4];
    if (bytes === undefined || offset === undefined || length === undefined || position === undefined) {
      context.unsupported(`${expr.fn} arguments`, expr.loc);
    }
    const runtimeFn = expr.fn === "fs.readSync" ? "fs_read_sync" : "fs_write_sync";
    return `runtime::${runtimeFn}(${context.emitExpr(arg)}, &(${context.emitExpr(bytes)}), ${context.emitExpr(offset)}, ${context.emitExpr(length)}, ${context.emitExpr(position)})`;
  }
  if (expr.fn === "fs.writeStrSync" && expr.args.length === 4 && arg !== undefined) {
    const value = expr.args[1];
    const position = expr.args[2];
    const encoding = expr.args[3];
    if (value === undefined || position === undefined || encoding === undefined) context.unsupported("fs.writeStrSync arguments", expr.loc);
    return `runtime::fs_write_str_sync(${context.emitExpr(arg)}, &(${context.emitExpr(value)}), ${context.emitExpr(position)}, &(${context.emitExpr(encoding)}))`;
  }
  if (expr.fn === "cp.execSync" && expr.args.length === 11 && arg !== undefined) {
    const [argv, shell, input, hasInput, cwd, hasEnv, envPairs, timeout, stdoutMode, stderrMode] = expr.args.slice(1);
    if (argv === undefined || shell === undefined || input === undefined || hasInput === undefined ||
        cwd === undefined || hasEnv === undefined || envPairs === undefined || timeout === undefined ||
        stdoutMode === undefined || stderrMode === undefined) context.unsupported("cp.execSync arguments", expr.loc);
    return `runtime::child_exec_sync(&(${context.emitExpr(arg)}), &(${context.emitExpr(argv)}), ${context.emitExpr(shell)}, &(${context.emitExpr(input)}), ${context.emitExpr(hasInput)}, &(${context.emitExpr(cwd)}), ${context.emitExpr(hasEnv)}, &(${context.emitExpr(envPairs)}), ${context.emitExpr(timeout)}, ${context.emitExpr(stdoutMode)}, ${context.emitExpr(stderrMode)})`;
  }
  if ((expr.fn === "timers.setTimeout" || expr.fn === "timers.setTimeoutHandle" || expr.fn === "timers.setInterval") &&
      expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    if (arg.type.kind !== "func" || arg.type.params.length !== 0 || arg.type.ret.kind !== "void") {
      context.unsupported("setTimeout callback shape", expr.loc);
    }
    const callback = context.nextTemporary();
    const dispatch = context.emitClosureDispatch(callback, arg.type, [], expr.loc);
    const runtimeFn = expr.fn === "timers.setTimeout"
      ? "timer_set_timeout"
      : expr.fn === "timers.setTimeoutHandle" ? "timer_set_timeout_handle" : "timer_set_interval";
    return `{ let ${callback} = ${context.emitExpr(arg)}; runtime::${runtimeFn}(Box::new(move || { ${dispatch}; }), ${context.emitExpr(expr.args[1])}) }`;
  }
  if (expr.fn === "process.uptime" && expr.args.length === 0) return "runtime::process_uptime()";
  if (expr.fn === "perf.now" && expr.args.length === 0) return "runtime::performance_now()";
  if (expr.fn === "date.now" && expr.args.length === 0) return "runtime::date_now()";
  if (expr.fn === "date.newNow" && expr.args.length === 0) return "runtime::date_now()";
  if ((expr.fn === "date.newMs" || expr.fn === "date.getTime" || expr.fn === "date.valueOf") &&
      expr.args.length === 1 && arg !== undefined) {
    const runtimeFn = expr.fn === "date.newMs" ? "date_new_ms" : "date_get_time";
    return `runtime::${runtimeFn}(${context.emitExpr(arg)})`;
  }
  if ((expr.fn === "date.newString" || expr.fn === "date.parseGetTime") &&
      expr.args.length === 1 && arg !== undefined) {
    return `runtime::date_parse_get_time(&(${context.emitExpr(arg)}))`;
  }
  if ((expr.fn === "date.toISOString" || expr.fn === "date.toISOStringValue") &&
      expr.args.length === 1 && arg !== undefined) {
    return `runtime::date_to_iso(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "date.utc" && expr.args.length === 7) {
    return `runtime::date_utc(${expr.args.map((value) => context.emitExpr(value)).join(", ")})`;
  }
  const dateGetter = new Map<string, [string, boolean]>([
    ["date.getFullYear", ["date_get_full_year", false]],
    ["date.getUTCFullYear", ["date_get_full_year", true]],
    ["date.getMonth", ["date_get_month", false]],
    ["date.getUTCMonth", ["date_get_month", true]],
    ["date.getDate", ["date_get_date", false]],
    ["date.getUTCDate", ["date_get_date", true]],
    ["date.getDay", ["date_get_day", false]],
    ["date.getUTCDay", ["date_get_day", true]],
    ["date.getHours", ["date_get_hours", false]],
    ["date.getUTCHours", ["date_get_hours", true]],
    ["date.getMinutes", ["date_get_minutes", false]],
    ["date.getUTCMinutes", ["date_get_minutes", true]],
    ["date.getSeconds", ["date_get_seconds", false]],
    ["date.getUTCSeconds", ["date_get_seconds", true]],
  ]).get(expr.fn);
  if (dateGetter !== undefined && expr.args.length === 1 && arg !== undefined) {
    return `runtime::${dateGetter[0]}(${context.emitExpr(arg)}, ${dateGetter[1]})`;
  }
  if ((expr.fn === "date.getMilliseconds" || expr.fn === "date.getUTCMilliseconds") &&
      expr.args.length === 1 && arg !== undefined) {
    return `runtime::date_get_milliseconds(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "date.getTimezoneOffset" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::date_get_timezone_offset(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "url.new" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::url_new(&(${context.emitExpr(arg)}))`;
  }
  const urlGetter = new Map<string, string>([
    ["url.protocol", "url_protocol"],
    ["url.host", "url_host"],
    ["url.hostname", "url_hostname"],
    ["url.pathname", "url_pathname"],
    ["url.href", "url_href"],
  ]).get(expr.fn);
  if (urlGetter !== undefined && expr.args.length === 1 && arg !== undefined) {
    return `runtime::${urlGetter}(&(${context.emitExpr(arg)}))`;
  }
  const urlFileBridge = new Map<string, string>([
    ["url.fileURLToPathUrl", "url_file_url_to_path"],
    ["url.fileURLToPathStr", "url_string_to_path"],
    ["url.pathToFileURL", "url_path_to_file_url"],
    ["url.pathToFileURLWin32", "url_path_to_file_url"],
  ]).get(expr.fn);
  if (urlFileBridge !== undefined) {
    if (expr.args.length !== 1 || arg === undefined) {
      context.unsupported(`${expr.fn} arguments`, expr.loc);
    }
    return `runtime::${urlFileBridge}(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "sp.new" && expr.args.length === 0) return "runtime::search_params_new()";
  if ((expr.fn === "sp.parse" || expr.fn === "sp.copy" || expr.fn === "sp.fromPairs" ||
      expr.fn === "url.searchParams" || expr.fn === "url.search") &&
      expr.args.length === 1 && arg !== undefined) {
    const runtimeFn = new Map<string, string>([
      ["sp.parse", "search_params_parse"],
      ["sp.copy", "search_params_copy"],
      ["sp.fromPairs", "search_params_from_array"],
      ["url.searchParams", "url_search_params"],
      ["url.search", "url_search"],
    ]).get(expr.fn);
    if (runtimeFn === undefined) context.unsupported(`URLSearchParams call '${expr.fn}'`, expr.loc);
    return `runtime::${runtimeFn}(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "sp.with" && expr.args.length === 3 && arg !== undefined &&
      expr.args[1] !== undefined && expr.args[2] !== undefined) {
    return `runtime::search_params_with(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}), &(${context.emitExpr(expr.args[2])}))`;
  }
  if (expr.fn === "sp.get" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    if (expr.type.kind !== "union") context.unsupported("URLSearchParams.get without a nullable result union", expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
    if (stringTag < 0 || nullTag < 0) context.unsupported("URLSearchParams.get result union shape", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::search_params_get(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])})) { Some(value) => ${name}::${context.unionVariant(stringTag)}(value), None => ${name}::${context.unionVariant(nullTag)}, }`;
  }
  if (expr.fn === "sp.getAll" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::search_params_get_all(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  const spMutation = new Map<string, string>([
    ["sp.append", "search_params_append"],
    ["sp.set", "search_params_set"],
    ["sp.delete", "search_params_delete"],
    ["sp.deleteValue", "search_params_delete_value"],
  ]).get(expr.fn);
  if (spMutation !== undefined && arg !== undefined && expr.args.length >= 2 && expr.args.length <= 3) {
    return `runtime::${spMutation}(${expr.args.map((value) => `&(${context.emitExpr(value)})`).join(", ")})`;
  }
  const spPredicate = new Map<string, string>([
    ["sp.has", "search_params_has"],
    ["sp.hasValue", "search_params_has_value"],
  ]).get(expr.fn);
  if (spPredicate !== undefined && arg !== undefined && expr.args.length >= 2 && expr.args.length <= 3) {
    return `runtime::${spPredicate}(${expr.args.map((value) => `&(${context.emitExpr(value)})`).join(", ")})`;
  }
  const spRead = new Map<string, string>([
    ["sp.sort", "search_params_sort"],
    ["sp.size", "search_params_size"],
    ["sp.toString", "search_params_to_string"],
  ]).get(expr.fn);
  if (spRead !== undefined && expr.args.length === 1 && arg !== undefined) {
    return `runtime::${spRead}(&(${context.emitExpr(arg)}))`;
  }
  const spIndexRead = new Map<string, string>([
    ["sp.keyAt", "search_params_key_at"],
    ["sp.valAt", "search_params_value_at"],
  ]).get(expr.fn);
  if (spIndexRead !== undefined && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::${spIndexRead}(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "process.activeResources" && expr.args.length === 0) return "runtime::process_active_resources()";
  const processSample = new Map<string, string>([
    ["process.availableMemory", "process_available_memory"],
    ["process.constrainedMemory", "process_constrained_memory"],
    ["process.cpuUser", "process_cpu_user"],
    ["process.cpuSystem", "process_cpu_system"],
    ["process.threadCpuUser", "process_thread_cpu_user"],
    ["process.threadCpuSystem", "process_thread_cpu_system"],
  ]).get(expr.fn);
  if (processSample !== undefined && expr.args.length === 0) return `runtime::${processSample}()`;
  const processDiff = new Map<string, string>([
    ["process.cpuUserDiff", "process_cpu_user"],
    ["process.cpuSystemDiff", "process_cpu_system"],
    ["process.threadCpuUserDiff", "process_thread_cpu_user"],
    ["process.threadCpuSystemDiff", "process_thread_cpu_system"],
  ]).get(expr.fn);
  if (processDiff !== undefined && expr.args.length === 1 && arg !== undefined) {
    return `(runtime::${processDiff}() - ${context.emitExpr(arg)})`;
  }
  if (expr.fn === "process.cpuPrevValidate" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::process_cpu_prev_validate(${context.emitExpr(arg)}, ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "process.rusage" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::process_rusage(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "tp.setTimeout" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::promise_timeout(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "tp.setImmediate" && expr.args.length === 0) {
    return "runtime::promise_immediate()";
  }
  if (expr.fn === "atomics.wait" && expr.args.length === 4 && arg !== undefined) {
    const [index, expected, timeout] = expr.args.slice(1);
    if (index === undefined || expected === undefined || timeout === undefined) {
      context.unsupported("atomics.wait arguments", expr.loc);
    }
    return `runtime::atomics_wait(&(${context.emitExpr(arg)}), ${context.emitExpr(index)}, ${context.emitExpr(expected)}, ${context.emitExpr(timeout)})`;
  }
  if ((expr.fn === "timers.setImmediate" || expr.fn === "timers.queueMicrotask" || expr.fn === "process.nextTick") &&
      expr.args.length === 1 && arg !== undefined) {
    if (arg.type.kind !== "func" || arg.type.params.length !== 0 || arg.type.ret.kind !== "void") {
      context.unsupported(`${expr.fn} callback shape`, expr.loc);
    }
    const callback = context.nextTemporary();
    const dispatch = context.emitClosureDispatch(callback, arg.type, [], expr.loc);
    const runtimeFn = expr.fn === "timers.setImmediate"
      ? "timer_set_immediate"
      : expr.fn === "timers.queueMicrotask" ? "timer_queue_microtask" : "process_next_tick";
    return `{ let ${callback} = ${context.emitExpr(arg)}; runtime::${runtimeFn}(Box::new(move || { ${dispatch}; })) }`;
  }
  if (expr.fn === "timers.clearImmediate" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::timer_clear_immediate(${context.emitExpr(arg)})`;
  }
  if ((expr.fn === "timers.immediateUnref" || expr.fn === "timers.immediateRef") && expr.args.length === 1 && arg !== undefined) {
    return `runtime::timer_set_immediate_ref(${context.emitExpr(arg)}, ${expr.fn === "timers.immediateRef"})`;
  }
  if (expr.fn === "timers.immediateHasRef" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::timer_immediate_has_ref(${context.emitExpr(arg)})`;
  }
  if ((expr.fn === "timers.clearTimeout" || expr.fn === "timers.clearInterval") && expr.args.length === 1 && arg !== undefined) {
    return `runtime::timer_clear(${context.emitExpr(arg)})`;
  }
  if ((expr.fn === "timers.unref" || expr.fn === "timers.ref") && expr.args.length === 1 && arg !== undefined) {
    return `runtime::timer_set_ref(${context.emitExpr(arg)}, ${expr.fn === "timers.ref"})`;
  }
  if (expr.fn === "timers.hasRef" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::timer_has_ref(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "timers.refresh" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::timer_refresh(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "cp.spawnSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::child_spawn_sync(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}), 0.0, &runtime::string(""), 0.0, 0.0, 0.0)`;
  }
  if (expr.fn === "cp.spawnSyncOpts" && expr.args.length === 7 && arg !== undefined) {
    const [argv, timeout, signal, stdinMode, stdoutMode, stderrMode] = expr.args.slice(1);
    if (argv === undefined || timeout === undefined || signal === undefined || stdinMode === undefined ||
        stdoutMode === undefined || stderrMode === undefined) context.unsupported("cp.spawnSyncOpts arguments", expr.loc);
    return `runtime::child_spawn_sync(&(${context.emitExpr(arg)}), &(${context.emitExpr(argv)}), ${context.emitExpr(timeout)}, &(${context.emitExpr(signal)}), ${context.emitExpr(stdinMode)}, ${context.emitExpr(stdoutMode)}, ${context.emitExpr(stderrMode)})`;
  }
  if (expr.fn === "cp.spawnSyncStdioStr" && expr.args.length === 5 && arg !== undefined) {
    const [argv, timeout, signal, stdio] = expr.args.slice(1);
    if (argv === undefined || timeout === undefined || signal === undefined || stdio === undefined) {
      context.unsupported("cp.spawnSyncStdioStr arguments", expr.loc);
    }
    return `runtime::child_spawn_sync_stdio(&(${context.emitExpr(arg)}), &(${context.emitExpr(argv)}), ${context.emitExpr(timeout)}, &(${context.emitExpr(signal)}), &(${context.emitExpr(stdio)}))`;
  }
  if ((expr.fn === "spawnRes.stdout" || expr.fn === "spawnRes.stderr") && expr.args.length === 1 && arg !== undefined) {
    return `runtime::spawn_result_${expr.fn === "spawnRes.stdout" ? "stdout" : "stderr"}(&(${context.emitExpr(arg)}))`;
  }
  if ((expr.fn === "spawnRes.status" || expr.fn === "spawnRes.signal" || expr.fn === "spawnRes.error") && expr.args.length === 1 && arg !== undefined) {
    if (expr.type.kind !== "union") context.unsupported(`${expr.fn} without a union result`, expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const valueKind = expr.fn === "spawnRes.status" ? "f64" : expr.fn === "spawnRes.signal" ? "string" : "object";
    const emptyKind = expr.fn === "spawnRes.error" ? "undefinedT" : "nullT";
    const valueTag = union.arms.findIndex((arm) => arm.kind === valueKind);
    const emptyTag = union.arms.findIndex((arm) => arm.kind === emptyKind);
    if (valueTag < 0 || emptyTag < 0) context.unsupported(`${expr.fn} result union shape`, expr.loc);
    const name = context.unionName(union.id);
    const accessor = expr.fn.slice("spawnRes.".length);
    return `match runtime::spawn_result_${accessor}(&(${context.emitExpr(arg)})) { Some(value) => ${name}::${context.unionVariant(valueTag)}(value), None => ${name}::${context.unionVariant(emptyTag)}, }`;
  }
  if (expr.fn === "buffer.fromStr" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::buffer_from_string(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "buffer.concat" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::buffer_concat(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "buffer.concatLen" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    const list = context.nextTemporary();
    const total = context.nextTemporary();
    return `{ let ${list} = ${context.emitExpr(arg)}; let ${total} = ${context.emitExpr(expr.args[1])}; runtime::buffer_concat_len(&${list}, ${total}) }`;
  }
  if (expr.fn === "buffer.byteLenStr" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    const value = context.nextTemporary();
    const encoding = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; let ${encoding} = ${context.emitExpr(expr.args[1])}; runtime::buffer_byte_length_string(&${value}, &${encoding}) }`;
  }
  if (expr.fn === "buffer.isEncoding" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::buffer_is_encoding(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "text.decode" && expr.args.length === 1 && arg?.type.kind === "bytes" && arg.type.elem === "u8") {
    return `runtime::text_decode(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "text.decodeLegacy" && expr.args.length === 2 &&
    arg?.type.kind === "bytes" && arg.type.elem === "u8" && expr.args[1]?.type.kind === "f64") {
    return `runtime::text_decode_legacy(&(${context.emitExpr(arg)}), ${context.emitExpr(expr.args[1])})`;
  }
  if ((expr.fn === "strdec.write" || expr.fn === "strdec.next") && expr.args.length === 3 &&
    arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
    const encoding = context.nextTemporary();
    const pending = context.nextTemporary();
    const chunk = context.nextTemporary();
    const helper = expr.fn === "strdec.write" ? "string_decoder_write" : "string_decoder_next";
    return `{ let ${encoding} = ${context.emitExpr(arg)}; let ${pending} = ${context.emitExpr(expr.args[1])}; let ${chunk} = ${context.emitExpr(expr.args[2])}; runtime::${helper}(&${encoding}, ${pending}, &${chunk}) }`;
  }
  if (expr.fn === "strdec.end" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    const encoding = context.nextTemporary();
    const pending = context.nextTemporary();
    return `{ let ${encoding} = ${context.emitExpr(arg)}; let ${pending} = ${context.emitExpr(expr.args[1])}; runtime::string_decoder_end(&${encoding}, ${pending}) }`;
  }
  if ((expr.fn === "fs.statSync" || expr.fn === "fs.lstatSync") && expr.args.length === 1 && arg !== undefined) {
    return `runtime::fs_stat(&(${context.emitExpr(arg)}), ${expr.fn === "fs.statSync"})`;
  }
  if (expr.fn === "stats.isFile" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_file(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "stats.isDirectory" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_directory(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "stats.isSymbolicLink" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_symlink(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "stats.size" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_size(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "stats.blocks" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_blocks(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "stats.nlink" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_nlink(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "stats.atimeMs" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_atime_ms(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "stats.mtimeMs" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_mtime_ms(&(${context.emitExpr(arg)}))`;
  if (expr.fn === "path.join" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_join(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32Join" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_win32_join(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32Resolve" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_win32_resolve(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32Normalize" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_win32_normalize(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32Dirname" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_win32_dirname(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32Extname" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_win32_extname(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32IsAbsolute" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_win32_is_absolute(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32ToNamespacedPath" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_win32_to_namespaced_path(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.win32Basename" && expr.args.length === 2 &&
    arg !== undefined && secondArg !== undefined) {
    return `runtime::path_win32_basename(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "path.win32Relative" && expr.args.length === 2 &&
    arg !== undefined && secondArg !== undefined) {
    return `runtime::path_win32_relative(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "path.resolve" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_resolve(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.normalize" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_normalize(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.dirname" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_dirname(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.extname" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_extname(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.isAbsolute" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::path_is_absolute(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "path.toNamespacedPath" && expr.args.length === 1 && arg !== undefined) {
    return context.emitExpr(arg);
  }
  if (expr.fn === "path.basename" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::path_basename(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "path.relative" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
    return `runtime::path_relative(&(${context.emitExpr(arg)}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "error.ctor" && expr.args.length === 2 && arg !== undefined &&
    expr.args[1] !== undefined && arg.type.kind === "object") {
    const error = RUNTIME_ERROR_CLASSES.get(arg.type.className);
    const receiverExpr = context.stripCasts(arg);
    if (error === undefined || receiverExpr.type.kind !== "object" ||
      !context.hasClassMeta(receiverExpr.type.className)) {
      context.unsupported("Error subclass constructor", expr.loc);
    }
    const receiver = context.nextTemporary();
    const message = context.nextTemporary();
    const nameField = context.classFieldName(receiverExpr.type.className, "name", expr.loc);
    const messageField = context.classFieldName(receiverExpr.type.className, "message", expr.loc);
    const codeField = context.classFieldName(receiverExpr.type.className, "%code", expr.loc);
    return `{ let ${receiver} = ${context.emitExpr(receiverExpr)}; let ${message} = ${context.emitExpr(expr.args[1])}; ${receiver}.with_mut(|object| { object.${nameField} = runtime::string("${context.rustString(error.lib)}"); object.${messageField} = ${message}; object.${codeField} = runtime::empty_string(); }); }`;
  }
  if (expr.fn === "error.new" && expr.args.length === 1 && arg !== undefined && expr.type.kind === "object") {
    const error = RUNTIME_ERROR_CLASSES.get(expr.type.className);
    if (error === undefined) context.unsupported(`error.new result '${expr.type.className}'`, expr.loc);
    const value = `runtime::error_new("${context.rustString(error.lib)}", ${context.emitExpr(arg)})`;
    return !context.hasErrorClassRoots() ? value : `${context.errorValueName()}::Builtin(${value})`;
  }
  if (expr.fn === "error.newDom" && expr.args.length === 2 && arg?.type.kind === "dyn" &&
    secondArg?.type.kind === "dyn" && expr.type.kind === "object" && expr.type.className === "%DOMException") {
    const message = context.nextTemporary();
    const options = context.nextTemporary();
    const messageString = context.nextTemporary();
    const name = context.nextTemporary();
    const cause = context.nextTemporary();
    const dyn = context.dynTypeName();
    const value = `{ let ${message} = ${context.emitExpr(arg)}; let ${options} = ${context.emitExpr(secondArg)}; let ${messageString} = if matches!(&${message}, ${dyn}::Undefined) { runtime::empty_string() } else { sc_dyn_to_string(&${message}) }; let (${name}, ${cause}) = match &${options} { ${dyn}::Undefined => (runtime::string("Error"), None), ${dyn}::Object(object) => { let name_value = runtime::map_get_by(object, &runtime::string("name"), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${dyn}::Undefined); let cause_value = runtime::map_get_by(object, &runtime::string("cause"), |left, right| left.as_ref() == right.as_ref()).map(runtime::caught_value); (sc_dyn_to_string(&name_value), cause_value) }, _ => (sc_dyn_to_string(&${options}), None), }; runtime::dom_exception_new(${messageString}, ${name}, ${cause}) }`;
    return !context.hasErrorClassRoots() ? value : `${context.errorValueName()}::Builtin(${value})`;
  }
  if ((expr.fn === "error.domCode" || expr.fn === "error.domHasCause") &&
    expr.args.length === 1 && arg?.type.kind === "object" && arg.type.className === "%DOMException") {
    const helper = expr.fn === "error.domCode" ? "error_dom_code" : "error_dom_has_cause";
    if (!context.hasErrorClassRoots()) {
      return `runtime::${helper}(&(${context.emitExpr(arg)}))`;
    }
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; match &${value} { ${context.errorValueName()}::Builtin(error) => runtime::${helper}(error), _ => unreachable!("scriptc invariant: DOMException is not builtin"), } }`;
  }
  if (expr.fn === "error.domCause" && expr.args.length === 1 &&
    arg?.type.kind === "object" && arg.type.className === "%DOMException" && expr.type.kind === "dyn") {
    const dyn = context.dynTypeName();
    if (!context.hasErrorClassRoots()) {
      return `runtime::error_dom_cause::<${dyn}>(&(${context.emitExpr(arg)})).unwrap_or(${dyn}::Undefined)`;
    }
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; match &${value} { ${context.errorValueName()}::Builtin(error) => runtime::error_dom_cause::<${dyn}>(error).unwrap_or(${dyn}::Undefined), _ => unreachable!("scriptc invariant: DOMException is not builtin"), } }`;
  }
  if (expr.fn === "error.domClone" && expr.args.length === 2 &&
    arg?.type.kind === "object" && arg.type.className === "%DOMException" &&
    secondArg?.type.kind === "dyn" && expr.type.kind === "object" &&
    expr.type.className === "%DOMException") {
    const value = context.nextTemporary();
    const options = context.nextTemporary();
    if (!context.hasErrorClassRoots()) {
      return `{ let ${value} = ${context.emitExpr(arg)}; let ${options} = ${context.emitExpr(secondArg)}; sc_dyn_validate_clone_options(&${options}); runtime::error_dom_clone(&${value}) }`;
    }
    return `{ let ${value} = ${context.emitExpr(arg)}; let ${options} = ${context.emitExpr(secondArg)}; sc_dyn_validate_clone_options(&${options}); match &${value} { ${context.errorValueName()}::Builtin(error) => ${context.errorValueName()}::Builtin(runtime::error_dom_clone(error)), _ => unreachable!("scriptc invariant: DOMException is not builtin"), } }`;
  }
  if (expr.fn === "assert.eqDyn" && expr.args.length === 6 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    const actual = context.nextTemporary();
    const expected = context.nextTemporary();
    const negated = context.nextTemporary();
    const deep = context.nextTemporary();
    const message = context.nextTemporary();
    const hasMessage = context.nextTemporary();
    return `{ let ${actual} = ${context.emitExpr(arg)}; let ${expected} = ${context.emitExpr(secondArg)}; let ${negated} = ${context.emitExpr(expr.args[2])}; let ${deep} = ${context.emitExpr(expr.args[3])}; let ${message} = ${context.emitExpr(expr.args[4])}; let ${hasMessage} = ${context.emitExpr(expr.args[5])}; sc_dyn_assert_message(&${actual}, &${expected}, ${negated}, ${deep}, &${message}, ${hasMessage}); () }`;
  }
  if (expr.fn === "assert.ok" && expr.args.length === 2 &&
    arg?.type.kind === "bool" && secondArg?.type.kind === "string") {
    return `runtime::assert_ok(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if ((expr.fn === "assert.eqF64" || expr.fn === "assert.eqStr" || expr.fn === "assert.eqBool") &&
    expr.args.length === 6 && arg !== undefined && secondArg !== undefined &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    const helper = expr.fn === "assert.eqF64" ? "assert_eq_f64" :
      expr.fn === "assert.eqStr" ? "assert_eq_string" : "assert_eq_bool";
    const borrowed = expr.fn === "assert.eqStr";
    const value = (index: number): string => {
      const valueExpr = expr.args[index];
      if (valueExpr === undefined) context.unsupported(`${expr.fn} argument arity`, expr.loc);
      const emitted = context.emitExpr(valueExpr);
      return borrowed && index < 2 ? `&(${emitted})` : emitted;
    };
    return `runtime::${helper}(${value(0)}, ${value(1)}, ${value(2)}, ${value(3)}, &(${value(4)}), ${value(5)})`;
  }
  if (expr.fn === "assert.eqSym" && expr.args.length === 6 &&
    arg?.type.kind === "symbol" && secondArg?.type.kind === "symbol" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    return `runtime::assert_eq_symbol(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, ${context.emitExpr(expr.args[3])}, &(${context.emitExpr(expr.args[4])}), ${context.emitExpr(expr.args[5])})`;
  }
  if (expr.fn === "assert.sameValue" && expr.args.length === 2 &&
    arg?.type.kind === "f64" && secondArg?.type.kind === "f64") {
    return `runtime::assert_same_value_f64(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "assert.bytesDeepEq" && expr.args.length === 3 &&
    arg?.type.kind === "bytes" && secondArg?.type.kind === "bytes" &&
    expr.args[2]?.type.kind === "bool") {
    return `(${context.emitExpr(expr.args[2])} && runtime::bytes_deep_equals(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)})))`;
  }
  if (expr.fn === "assert.refEqBytes" && expr.args.length === 6 &&
    arg?.type.kind === "bytes" && secondArg?.type.kind === "bytes" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "bool" &&
    expr.args[4]?.type.kind === "string" && expr.args[5]?.type.kind === "bool") {
    return `runtime::assert_ref_eq_bytes(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, ${context.emitExpr(expr.args[3])}, &(${context.emitExpr(expr.args[4])}), ${context.emitExpr(expr.args[5])})`;
  }
  if (expr.fn === "assert.refEqFn" && expr.args.length === 5 &&
    arg?.type.kind === "func" && secondArg?.type.kind === "func" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "string" &&
    expr.args[4]?.type.kind === "bool") {
    const values = expr.args.map(() => context.nextTemporary());
    const bindings = expr.args.map((value, index) => `let ${values[index]} = ${context.emitExpr(value)};`).join(" ");
    const left = values[0];
    const right = values[1];
    if (left === undefined || right === undefined) context.unsupported("assert.refEqFn argument arity", expr.loc);
    return `{ ${bindings} runtime::assert_ref_eq_function(${context.functionIdentity(left, arg.type, expr.loc)}, ${context.functionIdentity(right, secondArg.type, expr.loc)}, ${values[2]}, &${values[3]}, ${values[4]}) }`;
  }
  if (expr.fn === "assert.match" && expr.args.length === 5 &&
    arg?.type.kind === "string" && secondArg?.type.kind === "regex" &&
    expr.args[2]?.type.kind === "bool" && expr.args[3]?.type.kind === "string" &&
    expr.args[4]?.type.kind === "bool") {
    return `runtime::assert_match(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, &(${context.emitExpr(expr.args[3])}), ${context.emitExpr(expr.args[4])})`;
  }
  if (expr.fn === "assert.deqEnter" && expr.args.length === 2 && arg !== undefined && secondArg !== undefined) {
    const left = context.nextTemporary();
    const right = context.nextTemporary();
    return `{ let ${left} = ${context.emitExpr(arg)}; let ${right} = ${context.emitExpr(secondArg)}; runtime::assert_deep_pair_enter(${left}.identity(), ${right}.identity()) }`;
  }
  if (expr.fn === "assert.deqLeave" && expr.args.length === 0) {
    return "runtime::assert_deep_pair_leave()";
  }
  if (expr.fn === "assert.deepResult" && expr.args.length === 4 &&
    arg?.type.kind === "bool" && secondArg?.type.kind === "bool" &&
    expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool") {
    return `runtime::assert_deep_result(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)}, &(${context.emitExpr(expr.args[2])}), ${context.emitExpr(expr.args[3])})`;
  }
  if (expr.fn === "assert.ifErrorErr" && expr.args.length === 1 && arg?.type.kind === "object") {
    const value = context.nextTemporary();
    const nameHelper = !context.hasErrorClassRoots() ? "runtime::error_name" : "sc_error_name";
    const messageHelper = !context.hasErrorClassRoots() ? "runtime::error_message" : "sc_error_message";
    return `{ let ${value} = ${context.emitExpr(arg)}; runtime::assert_if_error_parts(&${nameHelper}(&${value}), &${messageHelper}(&${value})) }`;
  }
  if (expr.fn === "assert.ifErrorF64" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::assert_if_error_f64(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "assert.ifErrorStr" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::assert_if_error_string(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "assert.ifErrorBool" && expr.args.length === 1 && arg?.type.kind === "bool") {
    return `runtime::assert_if_error_bool(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "assert.ifErrorDyn" && expr.args.length === 1 && arg?.type.kind === "dyn") {
    return `sc_dyn_assert_if_error(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "assert.shapeBegin" && expr.args.length === 1 &&
    arg?.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(arg.type.className)) {
    if (context.hasErrorClassRoots()) {
      context.unsupported("assertion shape over Error subclasses", expr.loc);
    }
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; runtime::assert_shape_begin(&${value}); () }`;
  }
  if (expr.fn === "assert.shapeStr" && expr.args.length === 2 &&
    arg?.type.kind === "f64" && secondArg?.type.kind === "string") {
    return `runtime::assert_shape_string(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "assert.shapeRe" && expr.args.length === 2 &&
    arg?.type.kind === "f64" && secondArg?.type.kind === "regex") {
    return `runtime::assert_shape_regex(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "assert.shapeEnd" && expr.args.length === 2 &&
    arg?.type.kind === "string" && secondArg?.type.kind === "bool") {
    return `runtime::assert_shape_end(&(${context.emitExpr(arg)}), ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "assert.throwsNone" && expr.args.length === 5 &&
    arg !== undefined && secondArg !== undefined && expr.args[2] !== undefined &&
    expr.args[3] !== undefined && expr.args[4] !== undefined) {
    return `runtime::assert_throws_none(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])}, &(${context.emitExpr(expr.args[3])}), ${context.emitExpr(expr.args[4])})`;
  }
  if (expr.fn === "assert.throwsMismatch" && expr.args.length === 4 &&
    arg !== undefined && secondArg?.type.kind === "object" && expr.args[2] !== undefined && expr.args[3] !== undefined) {
    const expected = context.nextTemporary();
    const error = context.nextTemporary();
    const message = context.nextTemporary();
    const hasMessage = context.nextTemporary();
    const nameHelper = !context.hasErrorClassRoots() ? "runtime::error_name" : "sc_error_name";
    const messageHelper = !context.hasErrorClassRoots() ? "runtime::error_message" : "sc_error_message";
    return `{ let ${expected} = ${context.emitExpr(arg)}; let ${error} = ${context.emitExpr(secondArg)}; let ${message} = ${context.emitExpr(expr.args[2])}; let ${hasMessage} = ${context.emitExpr(expr.args[3])}; runtime::assert_throws_mismatch(&${expected}, &${nameHelper}(&${error}), &${messageHelper}(&${error}), &${message}, ${hasMessage}) }`;
  }
  if (expr.fn === "assert.throwsRegex" && expr.args.length === 4 &&
    arg?.type.kind === "regex" && secondArg?.type.kind === "object" &&
    expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool") {
    const regex = context.nextTemporary();
    const error = context.nextTemporary();
    const message = context.nextTemporary();
    const hasMessage = context.nextTemporary();
    const toString = context.hasErrorClassRoots() ? "sc_error_to_string" : "runtime::error_to_string";
    return `{ let ${regex} = ${context.emitExpr(arg)}; let ${error} = ${context.emitExpr(secondArg)}; let ${message} = ${context.emitExpr(expr.args[2])}; let ${hasMessage} = ${context.emitExpr(expr.args[3])}; let sc_actual = ${toString}(&${error}); runtime::assert_throws_regex(&${regex}, &sc_actual, &${message}, ${hasMessage}) }`;
  }
  if (expr.fn === "assert.regexErrTest" && expr.args.length === 2 &&
    arg?.type.kind === "regex" && secondArg?.type.kind === "object") {
    const toString = context.hasErrorClassRoots() ? "sc_error_to_string" : "runtime::error_to_string";
    return `runtime::regex_hits(&(${context.emitExpr(arg)}), &${toString}(&(${context.emitExpr(secondArg)})))`;
  }
  if (expr.fn === "assert.unwantedRejection" && expr.args.length === 3 &&
    arg?.type.kind === "object" && secondArg?.type.kind === "string" &&
    expr.args[2]?.type.kind === "bool") {
    const messageHelper = context.hasErrorClassRoots() ? "sc_error_message" : "runtime::error_message";
    return `runtime::assert_unwanted_rejection(&${messageHelper}(&(${context.emitExpr(arg)})), &(${context.emitExpr(secondArg)}), ${context.emitExpr(expr.args[2])})`;
  }
  if (expr.fn === "class.name" && expr.args.length === 1 && arg !== undefined && arg.type.kind === "classval") {
    const value = context.nextTemporary();
    const arms = context.classNameArms(arg.type.className, expr.loc);
    return `{ let ${value} = ${context.emitExpr(arg)}; match ${value} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
  }
  context.unsupported(`library call '${expr.fn}'`, expr.loc);

}
