import type { IrExpr, SrcLoc } from "../../ir/nodes.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustCheckedBufferContext {
  dynTypeName(): string;
  emitExpr(expr: IrExpr): string;
  nextTemporary(): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit Buffer operations whose untyped arguments require Node's runtime validation ladder. */
export function emitRustCheckedBufferCall(
  expr: RustLibCallExpr,
  context: RustCheckedBufferContext,
): string | null {
  const dyn = context.dynTypeName();
  if (expr.fn === "buffer.compareChk") {
    if (expr.args.length !== 2 || expr.args.some((arg) => arg.type.kind !== "dyn") ||
      expr.type.kind !== "f64") context.unsupported("checked Buffer.compare shape", expr.loc);
    const values = temporaries(expr.args, context);
    const left = required(values, 0, context, expr.loc);
    const right = required(values, 1, context, expr.loc);
    return `{ ${bindings(expr.args, values, context)} let sc_left = ${checkedBytes(left, "buf1", dyn)}; let sc_right = ${checkedBytes(right, "buf2", dyn)}; runtime::bytes_compare(&sc_left, &sc_right, 0_usize, 0.0, 0.0, 0.0, 0.0) }`;
  }
  if (expr.fn === "bytes.equalsChk") {
    const [receiver, other] = expr.args;
    if (!isU8Bytes(receiver) || other?.type.kind !== "dyn" || expr.args.length !== 2 ||
      expr.type.kind !== "bool") context.unsupported("checked Buffer.equals shape", expr.loc);
    const values = temporaries(expr.args, context);
    const receiverValue = required(values, 0, context, expr.loc);
    const otherValue = required(values, 1, context, expr.loc);
    return `{ ${bindings(expr.args, values, context)} let sc_other = ${checkedBytes(otherValue, "otherBuffer", dyn)}; runtime::bytes_equals(&${receiverValue}, &sc_other) }`;
  }
  if (expr.fn === "bytes.compareChk") {
    const [source, target, ...offsets] = expr.args;
    if (!isU8Bytes(source) || target?.type.kind !== "dyn" || offsets.length !== 4 ||
      offsets.some((arg) => arg.type.kind !== "dyn") || expr.type.kind !== "f64") {
      context.unsupported("checked Buffer.compare instance shape", expr.loc);
    }
    const values = temporaries(expr.args, context);
    const sourceValue = required(values, 0, context, expr.loc);
    const targetValue = required(values, 1, context, expr.loc);
    const targetStart = required(values, 2, context, expr.loc);
    const targetEnd = required(values, 3, context, expr.loc);
    const sourceStart = required(values, 4, context, expr.loc);
    const sourceEnd = required(values, 5, context, expr.loc);
    return `{ ${bindings(expr.args, values, context)} let sc_target = ${checkedBytes(targetValue, "target", dyn)}; let sc_target_start = ${checkedOffset(targetStart, "targetStart", "9_007_199_254_740_991.0", "0.0", dyn)}; let sc_target_end = ${checkedOffset(targetEnd, "targetEnd", "runtime::bytes_len(&sc_target)", "runtime::bytes_len(&sc_target)", dyn)}; let sc_source_start = ${checkedOffset(sourceStart, "sourceStart", "9_007_199_254_740_991.0", "0.0", dyn)}; let sc_source_end = ${checkedOffset(sourceEnd, "sourceEnd", `runtime::bytes_len(&${sourceValue})`, `runtime::bytes_len(&${sourceValue})`, dyn)}; runtime::bytes_compare(&${sourceValue}, &sc_target, 4_usize, sc_target_start, sc_target_end, sc_source_start, sc_source_end) }`;
  }
  if (expr.fn === "buffer.newStringFail") {
    const [got] = expr.args;
    if (got?.type.kind !== "dyn" || expr.args.length !== 1 || !isU8Bytes(expr)) {
      context.unsupported("checked deprecated Buffer constructor shape", expr.loc);
    }
    const value = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(got)}; sc_dyn_arg_type_fail("string", "of type string", &${value}) }`;
  }
  return null;
}

function checkedBytes(value: string, name: string, dyn: string): string {
  return `match &${value} { ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => sc_bytes.clone(), sc_value => sc_dyn_arg_type_fail("${name}", "an instance of Buffer or Uint8Array", sc_value), }`;
}

function checkedOffset(value: string, name: string, max: string, fallback: string, dyn: string): string {
  return `match &${value} { ${dyn}::Undefined => ${fallback}, ${dyn}::Number(sc_number) => { runtime::bytes_validate_offset("${name}", *sc_number, ${max}); *sc_number }, sc_value => sc_dyn_arg_type_fail("${name}", "of type number", sc_value), }`;
}

function isU8Bytes(expr: IrExpr | undefined): boolean {
  return expr?.type.kind === "bytes" && expr.type.elem === "u8";
}

function temporaries(args: readonly IrExpr[], context: RustCheckedBufferContext): string[] {
  return args.map(() => context.nextTemporary());
}

function bindings(args: readonly IrExpr[], values: readonly string[], context: RustCheckedBufferContext): string {
  return args.map((arg, index) => `let ${values[index]} = ${context.emitExpr(arg)};`).join(" ");
}

function required(
  values: readonly string[],
  index: number,
  context: RustCheckedBufferContext,
  loc: SrcLoc,
): string {
  return values[index] ?? context.unsupported("checked Buffer temporary", loc);
}
