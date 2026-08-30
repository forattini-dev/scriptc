import type { IrExpr, IrFfiImport, SrcLoc } from "../../ir/nodes.js";

type IrFfiCall = Extract<IrExpr, { kind: "ffiCall" }>;

interface RustFfiContext {
  unsupported(kind: string, loc?: SrcLoc): never;
}

type ScalarClass = "bool" | "f64";

function scalarClass(binding: IrFfiImport): ScalarClass | null {
  const parameter = binding.params[0];
  return binding.params.length === 1 && (parameter === "f64" || parameter === "bool") &&
      binding.returns === parameter
    ? parameter
    : null;
}

function abiType(cls: ScalarClass): string {
  return cls === "bool" ? "u8" : "f64";
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
  if (cls === null || expr.args.length !== 1 || argument?.type.kind !== cls || expr.type.kind !== cls) {
    context.unsupported(`native FFI import '${expr.import}' outside the scalar value ABI`, expr.loc);
  }
  const value = emitExpr(argument);
  return cls === "bool"
    ? `(unsafe { ${functionName(index)}(if ${value} { 1 } else { 0 }) } != 0)`
    : `unsafe { ${functionName(index)}(${value}) }`;
}
