import { isFfiCallbackParam, isFfiContextParam, type IrExpr, type IrFfiCallbackParam, type IrFfiImport, type IrType, type SrcLoc } from "../../ir/nodes.js";
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

export function emitRustFfiDeclarations(imports: readonly IrFfiImport[]): string[] {
  const declarations = imports.flatMap((binding, index) => {
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
  context: RustFfiContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const index = imports.findIndex((binding) => binding.name === expr.import);
  if (index < 0) context.unsupported(`unknown native FFI import '${expr.import}'`, expr.loc);
  const binding = imports[index];
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
    return marshalReturn(`unsafe { ${functionName(index)}() }`, signature.returns);
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
  return marshalReturn(call, signature.returns);
}
