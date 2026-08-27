import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

function emitDynamicArguments(value: string, args: string, dyn: string, context: RustLibCallContext): string {
  const index = context.nextTemporary();
  return `let mut ${args} = Vec::new(); if let ${dyn}::Array(sc_values) = &${value} { let mut ${index} = 0.0; while ${index} < runtime::array_len(sc_values) { ${args}.push(runtime::array_get(sc_values, ${index})); ${index} += 1.0; } }`;
}

export function emitRustAsyncLocalStorageCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (!expr.fn.startsWith("als.")) return null;
  const dyn = context.dynTypeName();
  const [handleExpr, valueExpr, fnExpr, argsExpr] = expr.args;
  if (expr.fn === "als.new" && expr.args.length === 0) {
    return `runtime::async_local_new::<${dyn}>()`;
  }
  if (expr.fn === "als.get" && expr.args.length === 1 && handleExpr?.type.kind === "f64") {
    return `runtime::async_local_get::<${dyn}>(${context.emitExpr(handleExpr)}).unwrap_or(${dyn}::Undefined)`;
  }
  if (expr.fn === "als.run" || expr.fn === "als.exitRun") {
    const callbackExpr = expr.fn === "als.run" ? fnExpr : valueExpr;
    const dynamicArgsExpr = expr.fn === "als.run" ? argsExpr : fnExpr;
    if (handleExpr?.type.kind !== "f64" || callbackExpr?.type.kind !== "dyn" ||
        dynamicArgsExpr?.type.kind !== "dyn" || (expr.fn === "als.run" && valueExpr?.type.kind !== "dyn")) return null;
    const handle = context.nextTemporary();
    const value = context.nextTemporary();
    const fn = context.nextTemporary();
    const argsValue = context.nextTemporary();
    const args = context.nextTemporary();
    const enter = expr.fn === "als.run"
      ? `let ${value} = ${context.emitExpr(valueExpr ?? context.unsupported("malformed AsyncLocalStorage.run IR"))}; let _sc_als_guard = runtime::async_local_run::<${dyn}>(${handle}, ${value});`
      : `let _sc_als_guard = runtime::async_local_exit::<${dyn}>(${handle});`;
    return `{ let ${handle} = ${context.emitExpr(handleExpr)}; ${enter} let ${fn} = ${context.emitExpr(callbackExpr)}; let ${argsValue} = ${context.emitExpr(dynamicArgsExpr)}; ${emitDynamicArguments(argsValue, args, dyn, context)} let _sc_this_guard = sc_dyn_this_push(${dyn}::Undefined); sc_dyn_call(&${fn}, &${args}, "${expr.fn === "als.run" ? "run" : "exit"}") }`;
  }
  if (expr.fn === "als.enterWith" && expr.args.length === 2 &&
      handleExpr?.type.kind === "f64" && valueExpr?.type.kind === "dyn") {
    return `runtime::async_local_enter_with::<${dyn}>(${context.emitExpr(handleExpr)}, ${context.emitExpr(valueExpr)}); ()`;
  }
  if (expr.fn === "als.disable" && expr.args.length === 1 && handleExpr?.type.kind === "f64") {
    return `runtime::async_local_disable::<${dyn}>(${context.emitExpr(handleExpr)}); ()`;
  }
  return null;
}
