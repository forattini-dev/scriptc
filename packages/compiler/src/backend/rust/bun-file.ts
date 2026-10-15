import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustBunFile(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn !== "bun.filePath" && expr.fn !== "bun.fileText") return null;
  const arg = expr.args[0];
  if (expr.args.length !== 1 || !arg || arg.type.kind !== "string") context.unsupported(`${expr.fn} signature`, expr.loc);
  const operation = expr.fn === "bun.filePath" ? "bun_file_path" : "bun_file_text";
  return `runtime::${operation}(&(${context.emitExpr(arg)}))`;
}
