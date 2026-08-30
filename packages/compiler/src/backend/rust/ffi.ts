import type { IrExpr, IrFfiImport, SrcLoc } from "../../ir/nodes.js";

type IrFfiCall = Extract<IrExpr, { kind: "ffiCall" }>;

interface RustFfiContext {
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
