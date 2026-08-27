import type { IrExpr } from "../../ir/nodes.js";

type BytesIntrinsic = Extract<IrExpr, { kind: "bytesIntrinsic" }>;

export interface RustBytesFillContext {
  emitExpr(expr: IrExpr): string;
  nextName(prefix: string): string;
}

export function emitRustBytesFillIntrinsic(
  expr: BytesIntrinsic,
  context: RustBytesFillContext,
): string | null {
  if (expr.method !== "fillElem" || expr.args.length < 1 || expr.args.length > 3 ||
    expr.args[0] === undefined) return null;
  const receiver = context.nextName("sc_rt");
  const args = expr.args.map(() => context.nextName("sc_rt"));
  const bindings = [
    `let ${receiver} = ${context.emitExpr(expr.receiver)};`,
    ...expr.args.map((arg, index) => `let ${args[index]} = ${context.emitExpr(arg)};`),
  ].join(" ");
  return `{ ${bindings} runtime::bytes_fill_elem(&${receiver}, ${args[0]}, ${args[1] ?? "0.0"}, ${args[2] ?? "f64::INFINITY"}) }`;
}
