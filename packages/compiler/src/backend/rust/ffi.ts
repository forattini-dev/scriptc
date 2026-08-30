import type { IrExpr, IrFfiImport, SrcLoc } from "../../ir/nodes.js";

type IrFfiCall = Extract<IrExpr, { kind: "ffiCall" }>;

interface RustFfiContext {
  unsupported(kind: string, loc?: SrcLoc): never;
}

type ScalarClass = "bool" | "f64" | "i32" | "u8" | "u32";

function scalarClass(binding: IrFfiImport): ScalarClass | null {
  const parameter = binding.params[0];
  return binding.params.length === 1 &&
      (parameter === "f64" || parameter === "bool" || parameter === "u8" ||
        parameter === "u32" || parameter === "i32") && binding.returns === parameter
    ? parameter
    : null;
}

function abiType(cls: ScalarClass): string {
  return cls === "bool" ? "u8" : cls;
}

function irKind(cls: ScalarClass): "bool" | "f64" {
  return cls === "bool" ? "bool" : "f64";
}

function functionName(index: number): string {
  return `sc_ffi_import_${index}`;
}

export function emitRustFfiDeclarations(imports: readonly IrFfiImport[]): string[] {
  const declarations = imports.flatMap((binding, index) => {
    const cls = scalarClass(binding);
    return cls === null
      ? []
      : [`    #[link_name = "${binding.symbol}"]`, `    fn ${functionName(index)}(sc_arg_0: ${abiType(cls)}) -> ${abiType(cls)};`];
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
  const argument = expr.args[0];
  const cls = binding === undefined ? null : scalarClass(binding);
  if (cls === null || expr.args.length !== 1 || argument?.type.kind !== irKind(cls) ||
      expr.type.kind !== irKind(cls)) {
    context.unsupported(`native FFI import '${expr.import}' outside the scalar value ABI`, expr.loc);
  }
  const value = emitExpr(argument);
  const argumentValue = cls === "bool"
    ? `if ${value} { 1 } else { 0 }`
    : cls === "u8"
      ? `runtime::to_uint32(${value}) as u8`
      : cls === "u32"
        ? `runtime::to_uint32(${value})`
        : cls === "i32"
          ? `runtime::to_int32(${value})`
          : value;
  const call = `unsafe { ${functionName(index)}(${argumentValue}) }`;
  return cls === "bool" ? `(${call} != 0)` : cls === "f64" ? call : `f64::from(${call})`;
}
