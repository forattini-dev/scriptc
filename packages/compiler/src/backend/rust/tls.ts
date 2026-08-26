import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustTlsCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const arg = expr.args[0];
  if (expr.fn === "tlsca.get" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::tls_ca_get(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "tlsca.root" && expr.args.length === 0) {
    return "runtime::tls_ca_root()";
  }
  if (expr.fn === "tlsca.set" && expr.args.length === 1 && arg?.type.kind === "array" &&
      arg.type.elem.kind === "string") {
    return `runtime::tls_ca_set_default(&(${context.emitExpr(arg)}))`;
  }
  return null;
}
