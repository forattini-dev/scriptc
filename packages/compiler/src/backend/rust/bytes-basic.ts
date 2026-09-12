import type { IrExpr } from "../../ir/ir.js";

type BytesIntrinsic = Extract<IrExpr, { kind: "bytesIntrinsic" }>;

export interface RustBytesBasicContext {
  emitExpr(expr: IrExpr): string;
  integerIndex(expr: IrExpr): string | undefined;
  regionReceiver(expr: IrExpr): string | null;
  readRegionReceiver(expr: IrExpr): string | null;
  borrowReceiver(expr: IrExpr, later: readonly IrExpr[]): string | null;
  nextName(prefix: string): string;
}

export function emitRustBytesBasicIntrinsic(
  expr: BytesIntrinsic,
  context: RustBytesBasicContext,
): string | null {
  const region = context.regionReceiver(expr.receiver) ?? context.readRegionReceiver(expr.receiver);
  if (region !== null) {
    if ((expr.method === "length" || expr.method === "byteLength") && expr.args.length === 0) return `(${region}.len() as f64)`;
    if (expr.method === "get" && expr.args[0] !== undefined && expr.args.length === 1) {
      const index = context.nextName("sc_rt");
      const integer = context.integerIndex(expr.args[0]);
      const getter = integer === undefined ? "bytes_region_get" : "bytes_region_get_usize";
      return `{ let ${index} = ${integer ?? context.emitExpr(expr.args[0])}; runtime::${getter}(&*${region}, ${index}) }`;
    }
  }
  const receiver = (): string => context.emitExpr(expr.receiver);
  const readReceiver = (): string => context.borrowReceiver(expr.receiver, expr.args) ?? receiver();
  if (expr.method === "length" && expr.args.length === 0) {
    return `runtime::bytes_len(&(${readReceiver()}))`;
  }
  if (expr.method === "byteLength" && expr.args.length === 0) {
    return `runtime::bytes_byte_len(&(${readReceiver()}))`;
  }
  if (expr.method === "get" && expr.args.length === 1 && expr.args[0] !== undefined) {
    const integer = context.integerIndex(expr.args[0]);
    return integer === undefined
      ? `runtime::bytes_get(&(${readReceiver()}), ${context.emitExpr(expr.args[0])})`
      : `runtime::bytes_get_usize(&(${readReceiver()}), ${integer})`;
  }
  if (expr.method === "slice" || expr.method === "subarray") {
    const start = expr.args[0] === undefined ? "0.0" : context.emitExpr(expr.args[0]);
    const end = expr.args[1] === undefined ? "f64::INFINITY" : context.emitExpr(expr.args[1]);
    return `runtime::bytes_slice(&(${receiver()}), ${start}, ${end}, ${expr.method === "subarray"})`;
  }
  if (expr.method === "setFrom" && expr.args[0] !== undefined) {
    const offset = expr.args[1] === undefined ? "0.0" : context.emitExpr(expr.args[1]);
    return `runtime::bytes_set_from(&(${receiver()}), &(${context.emitExpr(expr.args[0])}), ${offset})`;
  }
  if (expr.method === "join" && expr.args.length === 1 && expr.args[0] !== undefined) {
    const value = context.nextName("sc_rt");
    const separator = context.nextName("sc_rt");
    return `{ let ${value} = ${receiver()}; let ${separator} = ${context.emitExpr(expr.args[0])}; runtime::bytes_join(&${value}, &${separator}) }`;
  }
  if (expr.method === "toReversed" && expr.args.length === 0) {
    const value = context.nextName("sc_rt");
    return `{ let ${value} = ${receiver()}; runtime::bytes_to_reversed(&${value}) }`;
  }
  if (expr.method === "with" && expr.args.length === 2 && expr.args[0] !== undefined &&
    expr.args[1] !== undefined) {
    const value = context.nextName("sc_rt");
    const index = context.nextName("sc_rt");
    const replacement = context.nextName("sc_rt");
    return `{ let ${value} = ${receiver()}; let ${index} = ${context.emitExpr(expr.args[0])}; let ${replacement} = ${context.emitExpr(expr.args[1])}; runtime::bytes_with(&${value}, ${index}, ${replacement}) }`;
  }
  if (expr.method === "toArray" && expr.args.length === 0) {
    const value = context.nextName("sc_rt");
    return `{ let ${value} = ${receiver()}; runtime::bytes_to_array(&${value}) }`;
  }
  return null;
}
