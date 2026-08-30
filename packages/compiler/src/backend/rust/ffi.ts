import { isFfiCallbackParam, type IrExpr, type IrFfiCallbackParam, type IrFfiImport, type IrType, type SrcLoc } from "../../ir/nodes.js";
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
    const trampoline = context.nextName("sc_ffi_callback");
    const incoming = context.nextName("sc_ffi_callback_incoming");
    const active = context.nextName("sc_ffi_callback_active");
    const previous = context.nextName("sc_ffi_callback_previous");
    const result = context.nextName("sc_ffi_callback_result");
    const closureType = context.rustType(callbackArgument.type, expr.loc);
    const dispatch = context.emitClosureDispatch(active, callbackArgument.type, [incoming], expr.loc);
    return `{ let ${callbackValue} = ${emitExpr(callbackArgument)}; let ${nativeValue} = ${emitExpr(valueArgument)}; std::thread_local! { static ${slot}: std::cell::RefCell<Option<${closureType}>> = const { std::cell::RefCell::new(None) }; } extern "C" fn ${trampoline}(${incoming}: f64) -> f64 { ${slot}.with(|sc_slot| { let ${active} = sc_slot.borrow().as_ref().expect("scriptc: native callback outside its call scope").clone(); ${dispatch} }) } let ${previous} = ${slot}.with(|sc_slot| sc_slot.replace(Some(${callbackValue}))); let ${result} = unsafe { ${functionName(index)}(${trampoline}, ${nativeValue}) }; ${slot}.with(|sc_slot| { *sc_slot.borrow_mut() = ${previous}; }); ${result} }`;
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
