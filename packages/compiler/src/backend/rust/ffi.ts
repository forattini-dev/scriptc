import type { IrExpr, IrFfiImport, SrcLoc } from "../../ir/nodes.js";

type IrFfiCall = Extract<IrExpr, { kind: "ffiCall" }>;

interface RustFfiContext {
  unsupported(kind: string, loc?: SrcLoc): never;
}

function supportsScalarF64(binding: IrFfiImport): boolean {
  return binding.params.length === 1 && binding.params[0] === "f64" && binding.returns === "f64";
}

function functionName(index: number): string {
  return `sc_ffi_import_${index}`;
}

export function emitRustFfiDeclarations(imports: readonly IrFfiImport[]): string[] {
  const declarations = imports.flatMap((binding, index) => supportsScalarF64(binding)
    ? [`    #[link_name = "${binding.symbol}"]`, `    fn ${functionName(index)}(sc_arg_0: f64) -> f64;`]
    : []);
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
  if (binding === undefined || !supportsScalarF64(binding) || expr.args.length !== 1 ||
      argument?.type.kind !== "f64" || expr.type.kind !== "f64") {
    context.unsupported(`native FFI import '${expr.import}' outside the scalar f64 ABI`, expr.loc);
  }
  return `unsafe { ${functionName(index)}(${emitExpr(argument)}) }`;
}
