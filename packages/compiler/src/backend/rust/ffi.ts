import { isFfiCallbackParam, isFfiContextParam, isFfiReleaseParam, type IrExpr, type IrFfiCallbackParam, type IrFfiImport, type IrLibCallback, type IrType, type SrcLoc } from "../../ir/nodes.js";
import type { IrFuncType } from "./model.js";

type IrFfiCall = Extract<IrExpr, { kind: "ffiCall" }>;

interface RustFfiContext {
  nextName(prefix: string): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

type ScalarClass = "bool" | "f64" | "i32" | "u8" | "u32";
type ScalarReturn = ScalarClass | "void";

interface ScalarSignature {
  parameter: ScalarClass | null;
  returns: ScalarReturn;
}

function scalarSignature(binding: IrFfiImport): ScalarSignature | null {
  if (binding.params.length === 0 && binding.returns === "f64") {
    return { parameter: null, returns: "f64" };
  }
  const parameter = binding.params[0];
  if (binding.params.length !== 1 ||
      (parameter === "f64" || parameter === "bool" || parameter === "u8" ||
        parameter === "u32" || parameter === "i32") === false) return null;
  if (binding.returns !== parameter && !(parameter === "f64" && binding.returns === "void")) return null;
  return { parameter, returns: binding.returns };
}

function spanToF64(binding: IrFfiImport): "bytes" | "string" | null {
  const parameter = binding.params[0];
  return binding.params.length === 1 &&
    (parameter === "bytes" || parameter === "string") &&
    binding.returns === "f64"
    ? parameter
    : null;
}

function rawF64Callback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  return binding.params.length === 2 &&
    callback !== undefined &&
    isFfiCallbackParam(callback) &&
    callback.callback.params.length === 1 &&
    callback.callback.params[0] === "f64" &&
    callback.callback.returns === "f64" &&
    callback.callback.lifetime === "call" &&
    binding.params[1] === "f64" &&
    binding.returns === "f64"
    ? callback.callback
    : null;
}

function isRawF64CallbackPair(binding: IrFfiImport): boolean {
  const left = binding.params[0];
  const right = binding.params[1];
  const matches = (value: typeof left): boolean => value !== undefined &&
    isFfiCallbackParam(value) && value.callback.params.length === 1 &&
    value.callback.params[0] === "f64" && value.callback.returns === "f64" &&
    value.callback.lifetime === "call";
  return binding.params.length === 3 && matches(left) && matches(right) &&
    binding.params[2] === "f64" && binding.returns === "f64";
}

function contextF64Callback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  const context = binding.params[2];
  if (binding.params.length !== 3 || callback === undefined || context === undefined ||
      !isFfiCallbackParam(callback) || !isFfiContextParam(context)) return null;
  const callbackContext = callback.callback.params[1];
  return callback.callback.params.length === 2 &&
    callback.callback.params[0] === "f64" &&
    callbackContext !== undefined &&
    isFfiContextParam(callbackContext) &&
    callbackContext.context === callback.callback.id &&
    context.context === callback.callback.id &&
    callback.callback.returns === "f64" &&
    callback.callback.lifetime === "call" &&
    binding.params[1] === "f64" &&
    binding.returns === "f64"
    ? callback.callback
    : null;
}

function mixedContextCallback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  const context = binding.params[1];
  if (binding.params.length !== 2 || callback === undefined || context === undefined ||
      !isFfiCallbackParam(callback) || !isFfiContextParam(context)) return null;
  const params = callback.callback.params;
  const callbackContext = params[5];
  return params.length === 6 && params[0] === "bool" && params[1] === "u8" &&
    params[2] === "u32" && params[3] === "i32" && params[4] === "f64" &&
    callbackContext !== undefined && isFfiContextParam(callbackContext) &&
    callbackContext.context === callback.callback.id && context.context === callback.callback.id &&
    callback.callback.returns === "u32" && callback.callback.lifetime === "call" &&
    binding.returns === "u32"
    ? callback.callback
    : null;
}

function spanContextCallback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  const context = binding.params[1];
  if (binding.params.length !== 2 || callback === undefined || context === undefined ||
      !isFfiCallbackParam(callback) || !isFfiContextParam(context)) return null;
  const params = callback.callback.params;
  const callbackContext = params[2];
  return params.length === 3 && params[0] === "string" && params[1] === "bytes" &&
    callbackContext !== undefined && isFfiContextParam(callbackContext) &&
    callbackContext.context === callback.callback.id && context.context === callback.callback.id &&
    callback.callback.returns === "void" && callback.callback.lifetime === "call" &&
    binding.returns === "void"
    ? callback.callback
    : null;
}

function cstringContextCallback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  const context = binding.params[1];
  if (binding.params.length !== 2 || callback === undefined || context === undefined ||
      !isFfiCallbackParam(callback) || !isFfiContextParam(context)) return null;
  const params = callback.callback.params;
  const callbackContext = params[1];
  return params.length === 2 && params[0] === "cstring" &&
    callbackContext !== undefined && isFfiContextParam(callbackContext) &&
    callbackContext.context === callback.callback.id && context.context === callback.callback.id &&
    callback.callback.returns === "void" && callback.callback.lifetime === "call" &&
    binding.returns === "void"
    ? callback.callback
    : null;
}

function retainedContextCallback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  const context = binding.params[1];
  if (binding.params.length !== 2 || callback === undefined || context === undefined ||
      !isFfiCallbackParam(callback) || !isFfiContextParam(context)) return null;
  const params = callback.callback.params;
  const callbackContext = params[1];
  return params.length === 2 && params[0] === "f64" &&
    callbackContext !== undefined && isFfiContextParam(callbackContext) &&
    callbackContext.context === callback.callback.id && context.context === callback.callback.id &&
    callback.callback.returns === "void" && callback.callback.lifetime === "retained" &&
    callback.callback.invoke !== "foreign" && binding.returns === "void"
    ? callback.callback
    : null;
}

type ForeignParamClass = "bool" | "bytes" | "cstring" | "f64" | "i32" | "string" | "u32" | "u8";

function isForeignParamClass(value: unknown): value is ForeignParamClass {
  return value === "bool" || value === "bytes" || value === "cstring" || value === "f64" ||
    value === "i32" || value === "string" || value === "u32" || value === "u8";
}

function foreignContextCallback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  const context = binding.params[1];
  if (binding.params.length !== 2 || callback === undefined || context === undefined ||
      !isFfiCallbackParam(callback) || !isFfiContextParam(context)) return null;
  const params = callback.callback.params;
  const callbackContexts = params.filter(isFfiContextParam);
  const values = params.filter((param) => !isFfiContextParam(param));
  return values.length > 0 && values.every(isForeignParamClass) &&
    callbackContexts.length === 1 && callbackContexts[0]?.context === callback.callback.id &&
    context.context === callback.callback.id &&
    callback.callback.returns === "void" && callback.callback.lifetime === "retained" &&
    callback.callback.invoke === "foreign" && binding.returns === "void"
    ? callback.callback
    : null;
}

interface ForeignContextRelease {
  readonly callback: IrFfiCallbackParam["callback"];
  readonly key: string;
}

function foreignContextRelease(
  binding: IrFfiImport,
  imports: readonly IrFfiImport[],
): ForeignContextRelease | null {
  const release = binding.params[0];
  const context = binding.params[1];
  if (binding.params.length !== 2 || release === undefined || context === undefined ||
      !isFfiReleaseParam(release) || !isFfiContextParam(context) || binding.returns !== "void" ||
      context.context !== release.callback.release) return null;
  const separator = release.callback.release.lastIndexOf(":");
  if (separator < 1) return null;
  const sourceName = release.callback.release.slice(0, separator);
  const callbackId = release.callback.release.slice(separator + 1);
  const source = imports.find((candidate) => candidate.name === sourceName);
  const callback = source === undefined ? null : foreignContextCallback(source);
  return callback?.id === callbackId
    ? { callback, key: release.callback.release }
    : null;
}

function foreignParamTypes(param: ForeignParamClass | { readonly context: string }): string[] {
  if (typeof param === "object") return ["*mut std::ffi::c_void"];
  switch (param) {
    case "bool":
    case "u8": return ["u8"];
    case "u32": return ["u32"];
    case "i32": return ["i32"];
    case "f64": return ["f64"];
    case "cstring": return ["*const std::ffi::c_char"];
    case "string":
    case "bytes": return ["*const u8", "usize"];
  }
}

function foreignCallbackType(callback: IrFfiCallbackParam["callback"]): string {
  return `unsafe extern "C" fn(${callback.params.flatMap(foreignParamTypes).join(", ")})`;
}

function rawRetainedCallback(binding: IrFfiImport): IrFfiCallbackParam["callback"] | null {
  const callback = binding.params[0];
  return binding.params.length === 1 && callback !== undefined &&
    isFfiCallbackParam(callback) && callback.callback.params.length === 1 &&
    callback.callback.params[0] === "f64" && callback.callback.returns === "void" &&
    callback.callback.lifetime === "retained" && callback.callback.invoke !== "foreign" &&
    binding.returns === "void"
    ? callback.callback
    : null;
}

function retainedContextRelease(binding: IrFfiImport): string | null {
  const release = binding.params[0];
  const context = binding.params[1];
  if (binding.params.length !== 2 || release === undefined || context === undefined ||
      !isFfiReleaseParam(release) || !isFfiContextParam(context)) return null;
  const params = release.callback.params;
  return params.length === 2 && params[0] === "f64" &&
    params[1] !== undefined && isFfiContextParam(params[1]) &&
    release.callback.returns === "void" && context.context === release.callback.release &&
    binding.returns === "void"
    ? release.callback.release
    : null;
}

function rawRetainedRelease(binding: IrFfiImport): string | null {
  const release = binding.params[0];
  if (binding.params.length !== 1 || release === undefined || !isFfiReleaseParam(release)) return null;
  return release.callback.params.length === 1 && release.callback.params[0] === "f64" &&
    release.callback.returns === "void" && binding.returns === "void"
    ? release.callback.release
    : null;
}

function hasRetainedCallback(imports: readonly IrFfiImport[]): boolean {
  return imports.some((binding) => binding.params.some((parameter) =>
    isFfiCallbackParam(parameter) && parameter.callback.lifetime === "retained"));
}

function checkpointRetainedCallback(call: string, imports: readonly IrFfiImport[]): string {
  return hasRetainedCallback(imports)
    ? `{ let sc_ffi_call_result = ${call}; runtime::ffi_resume_callback_panic(); sc_ffi_call_result }`
    : call;
}

function abiType(cls: ScalarClass): string {
  return cls === "bool" ? "u8" : cls;
}

function irKind(cls: ScalarClass): "bool" | "f64" {
  return cls === "bool" ? "bool" : "f64";
}

function returnKind(cls: ScalarReturn): "bool" | "f64" | "void" {
  return cls === "void" ? "void" : irKind(cls);
}

function functionName(index: number): string {
  return `sc_ffi_import_${index}`;
}

function marshalReturn(call: string, cls: ScalarReturn): string {
  return cls === "bool"
    ? `(${call} != 0)`
    : cls === "f64" || cls === "void"
      ? call
      : `f64::from(${call})`;
}

export function emitRustFfiDeclarations(
  imports: readonly IrFfiImport[],
  libraryCallbacks: readonly IrLibCallback[] = [],
): string[] {
  const callbackNames = new Set(libraryCallbacks.map((callback) => callback.name));
  const declarations = imports.flatMap((binding, index) => {
    if (callbackNames.has(binding.name)) return [];
    const foreign = foreignContextRelease(binding, imports)?.callback ??
      foreignContextCallback(binding);
    if (foreign !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: ${foreignCallbackType(foreign)}, sc_arg_1: *mut std::ffi::c_void);`];
    }
    if (rawRetainedRelease(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: extern "C" fn(f64));`];
    }
    if (rawRetainedCallback(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: extern "C" fn(f64));`];
    }
    if (retainedContextRelease(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: unsafe extern "C" fn(f64, *mut std::ffi::c_void), sc_arg_1: *mut std::ffi::c_void);`];
    }
    if (retainedContextCallback(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: unsafe extern "C" fn(f64, *mut std::ffi::c_void), sc_arg_1: *mut std::ffi::c_void);`];
    }
    if (isRawF64CallbackPair(binding)) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: extern "C" fn(f64) -> f64, sc_arg_1: extern "C" fn(f64) -> f64, sc_arg_2: f64) -> f64;`];
    }
    if (cstringContextCallback(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: unsafe extern "C" fn(*const std::ffi::c_char, *mut std::ffi::c_void), sc_arg_1: *mut std::ffi::c_void);`];
    }
    if (spanContextCallback(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: unsafe extern "C" fn(*const u8, usize, *const u8, usize, *mut std::ffi::c_void), sc_arg_1: *mut std::ffi::c_void);`];
    }
    if (mixedContextCallback(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: unsafe extern "C" fn(u8, u8, u32, i32, f64, *mut std::ffi::c_void) -> u32, sc_arg_1: *mut std::ffi::c_void) -> u32;`];
    }
    if (contextF64Callback(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: unsafe extern "C" fn(f64, *mut std::ffi::c_void) -> f64, sc_arg_1: f64, sc_arg_2: *mut std::ffi::c_void) -> f64;`];
    }
    if (rawF64Callback(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0: extern "C" fn(f64) -> f64, sc_arg_1: f64) -> f64;`];
    }
    if (spanToF64(binding) !== null) {
      return [`    #[link_name = "${binding.symbol}"]`,
        `    fn ${functionName(index)}(sc_arg_0_ptr: *const u8, sc_arg_0_len: usize) -> f64;`];
    }
    const signature = scalarSignature(binding);
    if (signature === null) return [];
    const parameter = signature.parameter;
    return [`    #[link_name = "${binding.symbol}"]`,
      `    fn ${functionName(index)}(${parameter === null ? "" : `sc_arg_0: ${abiType(parameter)}`})${signature.returns === "void" ? "" : ` -> ${abiType(signature.returns)}`};`];
  });
  return declarations.length === 0
    ? []
    : ["unsafe extern \"C\" {", ...declarations, "}", ""];
}

export function emitRustFfiCall(
  expr: IrFfiCall,
  imports: readonly IrFfiImport[],
  libraryCallbacks: readonly IrLibCallback[],
  context: RustFfiContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const libraryCallback = libraryCallbacks.find((callback) => callback.name === expr.import);
  if (libraryCallback !== undefined) {
    if (libraryCallback.params.length !== 1 || libraryCallback.params[0] !== "f64" ||
        libraryCallback.returns !== "f64" || expr.args.length !== 1 ||
        expr.args[0]?.type.kind !== "f64" || expr.type.kind !== "f64") {
      context.unsupported(`library callback channel '${expr.import}' outside the f64 scalar ABI`, expr.loc);
    }
    const value = emitExpr(expr.args[0]);
    const raw = context.nextName("sc_library_callback_raw");
    const opaque = context.nextName("sc_library_callback_context");
    const callback = context.nextName("sc_library_callback_typed");
    return `{ let (${raw}, ${opaque}) = sc_library_callback(${libraryCallback.slot}); ` +
      `let ${callback}: unsafe extern "C" fn(*mut std::ffi::c_void, f64) -> f64 = ` +
      `unsafe { std::mem::transmute(${raw}) }; unsafe { ${callback}(${opaque}, ${value}) } }`;
  }
  const index = imports.findIndex((binding) => binding.name === expr.import);
  if (index < 0) context.unsupported(`unknown native FFI import '${expr.import}'`, expr.loc);
  const binding = imports[index];
  const foreignRelease = binding === undefined ? null : foreignContextRelease(binding, imports);
  if (foreignRelease !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the foreign retained release ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const identity = context.nextName("sc_ffi_callback_identity");
    const rawCallback = context.nextName("sc_ffi_callback_raw");
    const callback = context.nextName("sc_ffi_callback_typed");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const token = context.nextName("sc_ffi_callback_token");
    const key = JSON.stringify(foreignRelease.key);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${identity} = ${callbackValue}.identity(); let (${rawCallback}, ${pointer}, ${token}) = runtime::ffi_foreign_callback(${key}, ${identity}).unwrap_or_else(|| runtime::throw_error("releasing a native callback registration that does not exist".to_owned())); let ${callback}: ${foreignCallbackType(foreignRelease.callback)} = unsafe { std::mem::transmute(${rawCallback}) }; unsafe { ${functionName(index)}(${callback}, ${pointer}); } runtime::ffi_release_foreign_callback(${key}, ${identity}, ${token}); }`;
  }
  const foreignCallback = binding === undefined ? null : foreignContextCallback(binding);
  if (foreignCallback !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the foreign retained callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const identity = context.nextName("sc_ffi_callback_identity");
    const trampoline = context.nextName("sc_ffi_callback");
    const token = context.nextName("sc_ffi_callback_token");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const callbackPointer = context.nextName("sc_ffi_callback_function");
    const args = context.nextName("sc_ffi_callback_args");
    const active = context.nextName("sc_ffi_callback_active");
    let queueIndex = 0;
    let opaque = "";
    const parameters = foreignCallback.params.map((param) => {
      const names = foreignParamTypes(param).map((_type, part) => context.nextName(
        isFfiContextParam(param)
          ? "sc_ffi_callback_context"
          : part === 0 ? "sc_ffi_callback_incoming" : "sc_ffi_callback_length",
      ));
      if (isFfiContextParam(param)) opaque = names[0] ?? "";
      return { names, param };
    });
    const copies: string[] = [];
    const posted: string[] = [];
    const delivered: string[] = [];
    const dispatchArgs: string[] = [];
    for (const parameter of parameters) {
      if (isFfiContextParam(parameter.param)) continue;
      const incoming = parameter.names[0] ?? "";
      const deliveredName = context.nextName("sc_ffi_callback_argument");
      if (parameter.param === "cstring") {
        const bytes = context.nextName("sc_ffi_callback_bytes");
        copies.push(`if ${incoming}.is_null() { eprintln!("scriptc: native callback passed a NULL cstring"); std::process::abort(); }`,
          `let ${bytes} = unsafe { std::ffi::CStr::from_ptr(${incoming}) }.to_bytes().to_vec();`);
        posted.push(`runtime::FfiForeignArg::Data(${bytes})`);
        delivered.push(`let ${deliveredName} = runtime::ffi_foreign_arg_string(${args}, ${queueIndex});`);
      } else if (parameter.param === "string" || parameter.param === "bytes") {
        const length = parameter.names[1] ?? "";
        const bytes = context.nextName("sc_ffi_callback_bytes");
        copies.push(`if ${incoming}.is_null() && ${length} != 0 { eprintln!("scriptc: native callback passed a NULL ${parameter.param} span with nonzero length"); std::process::abort(); }`,
          `let ${bytes} = if ${length} == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(${incoming}, ${length}) }.to_vec() };`);
        posted.push(`runtime::FfiForeignArg::Data(${bytes})`);
        delivered.push(`let ${deliveredName} = runtime::ffi_foreign_arg_${parameter.param}(${args}, ${queueIndex});`);
      } else if (parameter.param === "bool") {
        posted.push(`runtime::FfiForeignArg::Bool(${incoming} != 0)`);
        delivered.push(`let ${deliveredName} = runtime::ffi_foreign_arg_bool(${args}, ${queueIndex});`);
      } else if (parameter.param === "f64") {
        posted.push(`runtime::FfiForeignArg::F64(${incoming})`);
        delivered.push(`let ${deliveredName} = runtime::ffi_foreign_arg_f64(${args}, ${queueIndex});`);
      } else {
        const variant = parameter.param === "u8" ? "U8" : parameter.param === "u32" ? "U32" : "I32";
        posted.push(`runtime::FfiForeignArg::${variant}(${incoming})`);
        delivered.push(`let ${deliveredName} = runtime::ffi_foreign_arg_${parameter.param}(${args}, ${queueIndex});`);
      }
      dispatchArgs.push(deliveredName);
      queueIndex++;
    }
    const trampolineParams = parameters
      .flatMap(({ names, param }) => names.map((name, index) =>
        `${name}: ${foreignParamTypes(param)[index] ?? ""}`))
      .join(", ");
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, dispatchArgs, expr.loc);
    const key = JSON.stringify(`${binding?.name ?? ""}:${foreignCallback.id}`);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${identity} = ${callbackValue}.identity(); unsafe extern "C" fn ${trampoline}(${trampolineParams}) { ${copies.join(" ")} runtime::ffi_foreign_post(${opaque} as usize, vec![${posted.join(", ")}]); } let ${token} = runtime::ffi_foreign_token(); let ${pointer} = runtime::ffi_foreign_context(${token}); let ${callbackPointer} = ${trampoline} as *const () as *const std::ffi::c_void; runtime::ffi_commit_foreign_callback(${key}, ${identity}, ${callbackPointer}, ${pointer}, ${token}, move |${args}: &[runtime::FfiForeignArg]| { ${delivered.join(" ")} let ${active} = ${callbackValue}.clone(); ${dispatch} }); unsafe { ${functionName(index)}(${trampoline}, ${pointer}); } }`;
  }
  const rawRelease = binding === undefined ? null : rawRetainedRelease(binding);
  if (rawRelease !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the raw retained release ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const identity = context.nextName("sc_ffi_callback_identity");
    const rawCallback = context.nextName("sc_ffi_callback_raw");
    const callback = context.nextName("sc_ffi_callback_typed");
    const key = JSON.stringify(rawRelease);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${identity} = ${callbackValue}.identity(); let (${rawCallback}, _) = runtime::ffi_retained_callback(${key}, ${identity}).unwrap_or_else(|| runtime::throw_error("releasing a native callback registration that does not exist".to_owned())); let ${callback}: extern "C" fn(f64) = unsafe { std::mem::transmute(${rawCallback}) }; unsafe { ${functionName(index)}(${callback}); } runtime::ffi_release_retained_callback(${key}, ${identity}, std::ptr::null_mut()); runtime::ffi_resume_callback_panic(); }`;
  }
  const rawRetained = binding === undefined ? null : rawRetainedCallback(binding);
  if (rawRetained !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the raw retained callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const slot = context.nextName("SC_FFI_RETAINED_CALLBACK");
    const trampoline = context.nextName("sc_ffi_callback");
    const cleanup = context.nextName("sc_ffi_callback_cleanup");
    const incoming = context.nextName("sc_ffi_callback_incoming");
    const active = context.nextName("sc_ffi_callback_active");
    const identity = context.nextName("sc_ffi_callback_identity");
    const callbackPointer = context.nextName("sc_ffi_callback_function");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [incoming], expr.loc);
    const key = JSON.stringify(`${binding?.name ?? ""}:${rawRetained.id}`);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${identity} = ${callbackValue}.identity(); std::thread_local! { static ${slot}: std::cell::RefCell<Option<${closureType}>> = const { std::cell::RefCell::new(None) }; } extern "C" fn ${trampoline}(${incoming}: f64) { if runtime::ffi_callback_panicked() { return; } let sc_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${slot}.with(|sc_slot| { let ${active} = sc_slot.borrow().as_ref().expect("scriptc: native callback outside its retained scope").clone(); ${dispatch} }))); if let Err(sc_payload) = sc_result { runtime::ffi_store_callback_panic(sc_payload); } } fn ${cleanup}() { ${slot}.with(|sc_slot| { *sc_slot.borrow_mut() = None; }); } let ${callbackPointer} = ${trampoline} as *const () as *const std::ffi::c_void; unsafe { ${functionName(index)}(${trampoline}); } runtime::ffi_retire_retained_raw_callback(${key}); ${slot}.with(|sc_slot| { *sc_slot.borrow_mut() = Some(${callbackValue}); }); runtime::ffi_commit_retained_raw_callback(${key}, ${identity}, ${callbackPointer}, ${cleanup}); runtime::ffi_resume_callback_panic(); }`;
  }
  const retainedRelease = binding === undefined ? null : retainedContextRelease(binding);
  if (retainedRelease !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the retained release ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const identity = context.nextName("sc_ffi_callback_identity");
    const rawCallback = context.nextName("sc_ffi_callback_raw");
    const callback = context.nextName("sc_ffi_callback_typed");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const key = JSON.stringify(retainedRelease);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${identity} = ${callbackValue}.identity(); let (${rawCallback}, ${pointer}) = runtime::ffi_retained_callback(${key}, ${identity}).unwrap_or_else(|| runtime::throw_error("releasing a native callback registration that does not exist".to_owned())); let ${callback}: unsafe extern "C" fn(f64, *mut std::ffi::c_void) = unsafe { std::mem::transmute(${rawCallback}) }; unsafe { ${functionName(index)}(${callback}, ${pointer}); } runtime::ffi_release_retained_callback(${key}, ${identity}, ${pointer}); runtime::ffi_resume_callback_panic(); }`;
  }
  const retainedCallback = binding === undefined ? null : retainedContextCallback(binding);
  if (retainedCallback !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the retained callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const trampoline = context.nextName("sc_ffi_callback");
    const incoming = context.nextName("sc_ffi_callback_incoming");
    const opaque = context.nextName("sc_ffi_callback_context");
    const active = context.nextName("sc_ffi_callback_active");
    const stateType = context.nextName("ScFfiRetainedContext");
    const state = context.nextName("sc_ffi_callback_state");
    const identity = context.nextName("sc_ffi_callback_identity");
    const callbackPointer = context.nextName("sc_ffi_callback_function");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [incoming], expr.loc);
    const key = JSON.stringify(`${binding?.name ?? ""}:${retainedCallback.id}`);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${identity} = ${callbackValue}.identity(); struct ${stateType} { callback: ${closureType}, } unsafe extern "C" fn ${trampoline}(${incoming}: f64, ${opaque}: *mut std::ffi::c_void) { if runtime::ffi_callback_panicked() { return; } let sc_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let ${state} = unsafe { &*${opaque}.cast::<${stateType}>() }; let ${active} = ${state}.callback.clone(); ${dispatch} })); if let Err(sc_payload) = sc_result { runtime::ffi_store_callback_panic(sc_payload); } } let ${state} = Box::new(${stateType} { callback: ${callbackValue} }); let ${pointer} = runtime::ffi_retained_context(${state}.as_ref()); let ${callbackPointer} = ${trampoline} as *const () as *const std::ffi::c_void; unsafe { ${functionName(index)}(${trampoline}, ${pointer}); } runtime::ffi_commit_retained_callback(${key}, ${identity}, ${callbackPointer}, ${pointer}, ${state}); runtime::ffi_resume_callback_panic(); }`;
  }
  if (binding !== undefined && isRawF64CallbackPair(binding)) {
    const leftArgument = expr.args[0];
    const rightArgument = expr.args[1];
    const valueArgument = expr.args[2];
    if (expr.args.length !== 3 || leftArgument?.type.kind !== "func" ||
        rightArgument?.type.kind !== "func" || valueArgument?.type.kind !== "f64" ||
        expr.type.kind !== "f64") {
      context.unsupported(`native FFI import '${expr.import}' outside the paired callback ABI`, expr.loc);
    }
    const leftValue = context.nextName("sc_ffi_callback_left_value");
    const rightValue = context.nextName("sc_ffi_callback_right_value");
    const nativeValue = context.nextName("sc_ffi_callback_argument");
    const leftSlot = context.nextName("SC_FFI_CALLBACK_LEFT");
    const rightSlot = context.nextName("SC_FFI_CALLBACK_RIGHT");
    const panicSlot = context.nextName("SC_FFI_CALLBACK_PANIC");
    const leftTrampoline = context.nextName("sc_ffi_callback_left");
    const rightTrampoline = context.nextName("sc_ffi_callback_right");
    const leftIncoming = context.nextName("sc_ffi_callback_left_incoming");
    const rightIncoming = context.nextName("sc_ffi_callback_right_incoming");
    const leftActive = context.nextName("sc_ffi_callback_left_active");
    const rightActive = context.nextName("sc_ffi_callback_right_active");
    const previousLeft = context.nextName("sc_ffi_callback_previous_left");
    const previousRight = context.nextName("sc_ffi_callback_previous_right");
    const previousPanic = context.nextName("sc_ffi_callback_previous_panic");
    const result = context.nextName("sc_ffi_callback_result");
    const panic = context.nextName("sc_ffi_callback_panic");
    const closureType = context.rustType(leftArgument.type, expr.loc);
    const leftDispatch = context.emitClosureDispatch(leftActive, leftArgument.type, [leftIncoming], expr.loc);
    const rightDispatch = context.emitClosureDispatch(rightActive, rightArgument.type, [rightIncoming], expr.loc);
    return `{ let ${leftValue} = ${emitExpr(leftArgument)}; let ${rightValue} = ${emitExpr(rightArgument)}; let ${nativeValue} = ${emitExpr(valueArgument)}; std::thread_local! { static ${leftSlot}: std::cell::RefCell<Option<${closureType}>> = const { std::cell::RefCell::new(None) }; static ${rightSlot}: std::cell::RefCell<Option<${closureType}>> = const { std::cell::RefCell::new(None) }; static ${panicSlot}: std::cell::RefCell<Option<Box<dyn std::any::Any + Send>>> = const { std::cell::RefCell::new(None) }; } extern "C" fn ${leftTrampoline}(${leftIncoming}: f64) -> f64 { if ${panicSlot}.with(|sc_slot| sc_slot.borrow().is_some()) { return 0.0; } match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${leftSlot}.with(|sc_slot| { let ${leftActive} = sc_slot.borrow().as_ref().expect("scriptc: native callback outside its call scope").clone(); ${leftDispatch} }))) { Ok(sc_value) => sc_value, Err(sc_payload) => { ${panicSlot}.with(|sc_slot| { *sc_slot.borrow_mut() = Some(sc_payload); }); 0.0 } } } extern "C" fn ${rightTrampoline}(${rightIncoming}: f64) -> f64 { if ${panicSlot}.with(|sc_slot| sc_slot.borrow().is_some()) { return 0.0; } match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${rightSlot}.with(|sc_slot| { let ${rightActive} = sc_slot.borrow().as_ref().expect("scriptc: native callback outside its call scope").clone(); ${rightDispatch} }))) { Ok(sc_value) => sc_value, Err(sc_payload) => { ${panicSlot}.with(|sc_slot| { *sc_slot.borrow_mut() = Some(sc_payload); }); 0.0 } } } let ${previousPanic} = ${panicSlot}.with(|sc_slot| sc_slot.take()); let ${previousLeft} = ${leftSlot}.with(|sc_slot| sc_slot.replace(Some(${leftValue}))); let ${previousRight} = ${rightSlot}.with(|sc_slot| sc_slot.replace(Some(${rightValue}))); let ${result} = unsafe { ${functionName(index)}(${leftTrampoline}, ${rightTrampoline}, ${nativeValue}) }; let ${panic} = ${panicSlot}.with(|sc_slot| sc_slot.take()); ${rightSlot}.with(|sc_slot| { *sc_slot.borrow_mut() = ${previousRight}; }); ${leftSlot}.with(|sc_slot| { *sc_slot.borrow_mut() = ${previousLeft}; }); ${panicSlot}.with(|sc_slot| { *sc_slot.borrow_mut() = ${previousPanic}; }); if let Some(sc_payload) = ${panic} { std::panic::resume_unwind(sc_payload); } ${result} }`;
  }
  const cstringCallback = binding === undefined ? null : cstringContextCallback(binding);
  if (cstringCallback !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the cstring callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const trampoline = context.nextName("sc_ffi_callback");
    const input = context.nextName("sc_ffi_callback_cstring");
    const opaque = context.nextName("sc_ffi_callback_context");
    const active = context.nextName("sc_ffi_callback_active");
    const value = context.nextName("sc_ffi_callback_string");
    const stateType = context.nextName("ScFfiCallbackContext");
    const state = context.nextName("sc_ffi_callback_state");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const panic = context.nextName("sc_ffi_callback_panic");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [value], expr.loc);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; struct ${stateType} { callback: ${closureType}, panic: std::cell::RefCell<Option<Box<dyn std::any::Any + Send>>>, } unsafe extern "C" fn ${trampoline}(${input}: *const std::ffi::c_char, ${opaque}: *mut std::ffi::c_void) { let ${state} = unsafe { &*${opaque}.cast::<${stateType}>() }; if ${state}.panic.borrow().is_some() { return; } let sc_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { if ${input}.is_null() { panic!("scriptc: native callback passed a NULL cstring"); } let sc_bytes = unsafe { std::ffi::CStr::from_ptr(${input}) }.to_bytes(); let ${value} = runtime::ffi_string_copy_in(sc_bytes); let ${active} = ${state}.callback.clone(); ${dispatch} })); if let Err(sc_payload) = sc_result { *${state}.panic.borrow_mut() = Some(sc_payload); } } let ${state} = ${stateType} { callback: ${callbackValue}, panic: std::cell::RefCell::new(None) }; let ${pointer} = (&${state} as *const ${stateType}).cast_mut().cast::<std::ffi::c_void>(); unsafe { ${functionName(index)}(${trampoline}, ${pointer}); } let ${panic} = ${state}.panic.take(); if let Some(sc_payload) = ${panic} { std::panic::resume_unwind(sc_payload); } }`;
  }
  const spanCallback = binding === undefined ? null : spanContextCallback(binding);
  if (spanCallback !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "void") {
      context.unsupported(`native FFI import '${expr.import}' outside the span callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const trampoline = context.nextName("sc_ffi_callback");
    const textPointer = context.nextName("sc_ffi_callback_text_pointer");
    const textLength = context.nextName("sc_ffi_callback_text_length");
    const bytesPointer = context.nextName("sc_ffi_callback_bytes_pointer");
    const bytesLength = context.nextName("sc_ffi_callback_bytes_length");
    const opaque = context.nextName("sc_ffi_callback_context");
    const active = context.nextName("sc_ffi_callback_active");
    const text = context.nextName("sc_ffi_callback_text");
    const bytes = context.nextName("sc_ffi_callback_bytes");
    const stateType = context.nextName("ScFfiCallbackContext");
    const state = context.nextName("sc_ffi_callback_state");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const panic = context.nextName("sc_ffi_callback_panic");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [text, bytes], expr.loc);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; struct ${stateType} { callback: ${closureType}, panic: std::cell::RefCell<Option<Box<dyn std::any::Any + Send>>>, } unsafe extern "C" fn ${trampoline}(${textPointer}: *const u8, ${textLength}: usize, ${bytesPointer}: *const u8, ${bytesLength}: usize, ${opaque}: *mut std::ffi::c_void) { let ${state} = unsafe { &*${opaque}.cast::<${stateType}>() }; if ${state}.panic.borrow().is_some() { return; } let sc_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { if (${textPointer}.is_null() && ${textLength} != 0) || (${bytesPointer}.is_null() && ${bytesLength} != 0) { panic!("scriptc: native callback passed an invalid span"); } let sc_text_slice: &[u8] = if ${textLength} == 0 { &[] } else { unsafe { std::slice::from_raw_parts(${textPointer}, ${textLength}) } }; let sc_bytes_slice: &[u8] = if ${bytesLength} == 0 { &[] } else { unsafe { std::slice::from_raw_parts(${bytesPointer}, ${bytesLength}) } }; let ${text} = runtime::ffi_string_copy_in(sc_text_slice); let ${bytes} = runtime::ffi_bytes_copy_in(sc_bytes_slice); let ${active} = ${state}.callback.clone(); ${dispatch} })); if let Err(sc_payload) = sc_result { *${state}.panic.borrow_mut() = Some(sc_payload); } } let ${state} = ${stateType} { callback: ${callbackValue}, panic: std::cell::RefCell::new(None) }; let ${pointer} = (&${state} as *const ${stateType}).cast_mut().cast::<std::ffi::c_void>(); unsafe { ${functionName(index)}(${trampoline}, ${pointer}); } let ${panic} = ${state}.panic.take(); if let Some(sc_payload) = ${panic} { std::panic::resume_unwind(sc_payload); } }`;
  }
  const mixedCallback = binding === undefined ? null : mixedContextCallback(binding);
  if (mixedCallback !== null) {
    const callbackArgument = expr.args[0];
    if (expr.args.length !== 1 || callbackArgument?.type.kind !== "func" || expr.type.kind !== "f64") {
      context.unsupported(`native FFI import '${expr.import}' outside the mixed callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const trampoline = context.nextName("sc_ffi_callback");
    const truth = context.nextName("sc_ffi_callback_truth");
    const byte = context.nextName("sc_ffi_callback_byte");
    const wide = context.nextName("sc_ffi_callback_wide");
    const signed = context.nextName("sc_ffi_callback_signed");
    const fraction = context.nextName("sc_ffi_callback_fraction");
    const opaque = context.nextName("sc_ffi_callback_context");
    const active = context.nextName("sc_ffi_callback_active");
    const stateType = context.nextName("ScFfiCallbackContext");
    const state = context.nextName("sc_ffi_callback_state");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const result = context.nextName("sc_ffi_callback_result");
    const panic = context.nextName("sc_ffi_callback_panic");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [
      `(${truth} != 0)`, `f64::from(${byte})`, `f64::from(${wide})`,
      `f64::from(${signed})`, fraction,
    ], expr.loc);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; struct ${stateType} { callback: ${closureType}, panic: std::cell::RefCell<Option<Box<dyn std::any::Any + Send>>>, } unsafe extern "C" fn ${trampoline}(${truth}: u8, ${byte}: u8, ${wide}: u32, ${signed}: i32, ${fraction}: f64, ${opaque}: *mut std::ffi::c_void) -> u32 { let ${state} = unsafe { &*${opaque}.cast::<${stateType}>() }; if ${state}.panic.borrow().is_some() { return 0; } match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let ${active} = ${state}.callback.clone(); runtime::to_uint32(${dispatch}) })) { Ok(sc_value) => sc_value, Err(sc_payload) => { *${state}.panic.borrow_mut() = Some(sc_payload); 0 } } } let ${state} = ${stateType} { callback: ${callbackValue}, panic: std::cell::RefCell::new(None) }; let ${pointer} = (&${state} as *const ${stateType}).cast_mut().cast::<std::ffi::c_void>(); let ${result} = unsafe { ${functionName(index)}(${trampoline}, ${pointer}) }; let ${panic} = ${state}.panic.take(); if let Some(sc_payload) = ${panic} { std::panic::resume_unwind(sc_payload); } f64::from(${result}) }`;
  }
  const contextCallback = binding === undefined ? null : contextF64Callback(binding);
  if (contextCallback !== null) {
    const callbackArgument = expr.args[0];
    const valueArgument = expr.args[1];
    if (expr.args.length !== 2 || callbackArgument?.type.kind !== "func" ||
        valueArgument?.type.kind !== "f64" || expr.type.kind !== "f64") {
      context.unsupported(`native FFI import '${expr.import}' outside the contextual callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const nativeValue = context.nextName("sc_ffi_callback_argument");
    const trampoline = context.nextName("sc_ffi_callback");
    const incoming = context.nextName("sc_ffi_callback_incoming");
    const opaque = context.nextName("sc_ffi_callback_context");
    const active = context.nextName("sc_ffi_callback_active");
    const stateType = context.nextName("ScFfiCallbackContext");
    const state = context.nextName("sc_ffi_callback_state");
    const pointer = context.nextName("sc_ffi_callback_pointer");
    const result = context.nextName("sc_ffi_callback_result");
    const panic = context.nextName("sc_ffi_callback_panic");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [incoming], expr.loc);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${nativeValue} = ${emitExpr(valueArgument)}; struct ${stateType} { callback: ${closureType}, panic: std::cell::RefCell<Option<Box<dyn std::any::Any + Send>>>, } unsafe extern "C" fn ${trampoline}(${incoming}: f64, ${opaque}: *mut std::ffi::c_void) -> f64 { let ${state} = unsafe { &*${opaque}.cast::<${stateType}>() }; if ${state}.panic.borrow().is_some() { return 0.0; } match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let ${active} = ${state}.callback.clone(); ${dispatch} })) { Ok(sc_value) => sc_value, Err(sc_payload) => { *${state}.panic.borrow_mut() = Some(sc_payload); 0.0 } } } let ${state} = ${stateType} { callback: ${callbackValue}, panic: std::cell::RefCell::new(None) }; let ${pointer} = (&${state} as *const ${stateType}).cast_mut().cast::<std::ffi::c_void>(); let ${result} = unsafe { ${functionName(index)}(${trampoline}, ${nativeValue}, ${pointer}) }; let ${panic} = ${state}.panic.take(); if let Some(sc_payload) = ${panic} { std::panic::resume_unwind(sc_payload); } ${result} }`;
  }
  const callback = binding === undefined ? null : rawF64Callback(binding);
  if (callback !== null) {
    const callbackArgument = expr.args[0];
    const valueArgument = expr.args[1];
    if (expr.args.length !== 2 || callbackArgument?.type.kind !== "func" ||
        valueArgument?.type.kind !== "f64" || expr.type.kind !== "f64") {
      context.unsupported(`native FFI import '${expr.import}' outside the call-scoped callback ABI`, expr.loc);
    }
    const callbackValue = context.nextName("sc_ffi_callback_value");
    const nativeValue = context.nextName("sc_ffi_callback_argument");
    const slot = context.nextName("SC_FFI_CALLBACK");
    const panicSlot = context.nextName("SC_FFI_CALLBACK_PANIC");
    const trampoline = context.nextName("sc_ffi_callback");
    const incoming = context.nextName("sc_ffi_callback_incoming");
    const active = context.nextName("sc_ffi_callback_active");
    const previous = context.nextName("sc_ffi_callback_previous");
    const previousPanic = context.nextName("sc_ffi_callback_previous_panic");
    const result = context.nextName("sc_ffi_callback_result");
    const panic = context.nextName("sc_ffi_callback_panic");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [incoming], expr.loc);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${nativeValue} = ${emitExpr(valueArgument)}; std::thread_local! { static ${slot}: std::cell::RefCell<Option<${closureType}>> = const { std::cell::RefCell::new(None) }; static ${panicSlot}: std::cell::RefCell<Option<Box<dyn std::any::Any + Send>>> = const { std::cell::RefCell::new(None) }; } extern "C" fn ${trampoline}(${incoming}: f64) -> f64 { if ${panicSlot}.with(|sc_slot| sc_slot.borrow().is_some()) { return 0.0; } match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${slot}.with(|sc_slot| { let ${active} = sc_slot.borrow().as_ref().expect("scriptc: native callback outside its call scope").clone(); ${dispatch} }))) { Ok(sc_value) => sc_value, Err(sc_payload) => { ${panicSlot}.with(|sc_slot| { *sc_slot.borrow_mut() = Some(sc_payload); }); 0.0 } } } let ${previousPanic} = ${panicSlot}.with(|sc_slot| sc_slot.take()); let ${previous} = ${slot}.with(|sc_slot| sc_slot.replace(Some(${callbackValue}))); let ${result} = unsafe { ${functionName(index)}(${trampoline}, ${nativeValue}) }; let ${panic} = ${panicSlot}.with(|sc_slot| sc_slot.take()); ${slot}.with(|sc_slot| { *sc_slot.borrow_mut() = ${previous}; }); ${panicSlot}.with(|sc_slot| { *sc_slot.borrow_mut() = ${previousPanic}; }); if let Some(sc_payload) = ${panic} { std::panic::resume_unwind(sc_payload); } ${result} }`;
  }
  const span = binding === undefined ? null : spanToF64(binding);
  if (span !== null) {
    const argument = expr.args[0];
    if (expr.args.length !== 1 || argument?.type.kind !== span || expr.type.kind !== "f64") {
      context.unsupported(`native FFI import '${expr.import}' outside the span value ABI`, expr.loc);
    }
    const value = context.nextName(`sc_ffi_${span}`);
    if (span === "bytes") {
      return `{ let ${value} = runtime::ffi_bytes_snapshot(&${emitExpr(argument)}); unsafe { ${functionName(index)}(${value}.as_ptr(), ${value}.len()) } }`;
    }
    return `{ let ${value} = ${emitExpr(argument)}; unsafe { ${functionName(index)}(${value}.as_bytes().as_ptr(), ${value}.len()) } }`;
  }
  const signature = binding === undefined ? null : scalarSignature(binding);
  if (signature === null || expr.type.kind !== returnKind(signature.returns)) {
    context.unsupported(`native FFI import '${expr.import}' outside the scalar value ABI`, expr.loc);
  }
  if (signature.parameter === null) {
    if (expr.args.length !== 0) {
      context.unsupported(`native FFI import '${expr.import}' outside the scalar value ABI`, expr.loc);
    }
    return checkpointRetainedCallback(
      marshalReturn(`unsafe { ${functionName(index)}() }`, signature.returns),
      imports,
    );
  }
  const argument = expr.args[0];
  if (expr.args.length !== 1 || argument?.type.kind !== irKind(signature.parameter)) {
    context.unsupported(`native FFI import '${expr.import}' outside the scalar value ABI`, expr.loc);
  }
  const value = emitExpr(argument);
  const argumentValue = signature.parameter === "bool"
    ? `if ${value} { 1 } else { 0 }`
    : signature.parameter === "u8"
      ? `runtime::to_uint32(${value}) as u8`
      : signature.parameter === "u32"
        ? `runtime::to_uint32(${value})`
        : signature.parameter === "i32"
          ? `runtime::to_int32(${value})`
          : value;
  const call = `unsafe { ${functionName(index)}(${argumentValue}) }`;
  return checkpointRetainedCallback(marshalReturn(call, signature.returns), imports);
}
