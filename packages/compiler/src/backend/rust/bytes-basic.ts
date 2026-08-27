import type { IrExpr } from "../../ir/nodes.js";

type BytesIntrinsic = Extract<IrExpr, { kind: "bytesIntrinsic" }>;

export interface RustBytesBasicContext {
  emitExpr(expr: IrExpr): string;
  nextName(prefix: string): string;
}

export function emitRustBytesBasicIntrinsic(
  expr: BytesIntrinsic,
  context: RustBytesBasicContext,
): string | null {
  const receiver = (): string => context.emitExpr(expr.receiver);
  if (expr.method === "length" && expr.args.length === 0) {
    return `runtime::bytes_len(&(${receiver()}))`;
  }
  if (expr.method === "byteLength" && expr.args.length === 0) {
    return `runtime::bytes_byte_len(&(${receiver()}))`;
  }
  if (expr.method === "get" && expr.args.length === 1 && expr.args[0] !== undefined) {
    return `runtime::bytes_get(&(${receiver()}), ${context.emitExpr(expr.args[0])})`;
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
