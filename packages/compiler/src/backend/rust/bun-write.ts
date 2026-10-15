import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustBunWrite(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn !== "bun.writeText" && expr.fn !== "bun.writeBytes") return null;
  const path = expr.args[0], data = expr.args[1], bytes = expr.fn === "bun.writeBytes";
  if (expr.args.length !== 2 || path?.type.kind !== "string" || !data ||
      (bytes ? data.type.kind !== "bytes" || data.type.elem !== "u8" : data.type.kind !== "string")) {
    context.unsupported(`${expr.fn} signature`, expr.loc);
  }
  const source = context.nextTemporary(), value = context.nextTemporary();
  return `{ let ${source} = ${context.emitExpr(path)}; let ${value} = ${context.emitExpr(data)}; runtime::${bytes ? "bun_write_bytes" : "bun_write_text"}(&${source}, &${value}) }`;
}
