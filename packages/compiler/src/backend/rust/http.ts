import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustHttpCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn === "http.createServerEmpty" && expr.args.length === 0) {
    return "runtime::http_server_new()";
  }
  if (expr.fn === "http.serverJoinDupHeaders" && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "netServer") {
    return `runtime::http_server_join_duplicate_headers(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "http.serverTimeoutGet" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64") {
    return `runtime::http_server_timeout_get(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "http.serverTimeoutSet" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "f64") {
    return `runtime::http_server_timeout_set(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])}, ${context.emitExpr(expr.args[2])})`;
  }
  if (expr.fn === "http.serverTimeoutOptionSet" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "dyn") {
    const server = context.nextTemporary();
    const selector = context.nextTemporary();
    const value = context.nextTemporary();
    const dyn = context.dynTypeName();
    return `{ let ${server} = ${context.emitExpr(expr.args[0])}; let ${selector} = ${context.emitExpr(expr.args[1])}; let ${value} = ${context.emitExpr(expr.args[2])}; let sc_option = match &${value} { ${dyn}::Undefined => None, ${dyn}::Number(sc_number) => Some(*sc_number), sc_value => sc_dyn_arg_type_fail("keepAliveTimeoutBuffer", "of type number", sc_value), }; runtime::http_server_timeout_option_set(&${server}, ${selector}, sc_option); }`;
  }
  return null;
}
