import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

function callbackIdentity(value: string): string {
  return `sc_dyn_function_identity(&${value}).unwrap_or_else(|| sc_dyn_arg_type_fail("subscription", "of type function", &${value}))`;
}

export function emitRustDiagnosticsChannelCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (!expr.fn.startsWith("dc.")) return null;
  const dyn = context.dynTypeName();
  const first = expr.args[0];
  const second = expr.args[1];

  if (expr.fn === "dc.channel" && expr.args.length === 1 && first?.type.kind === "string") {
    return `runtime::diagnostics_channel::<${dyn}>(&(${context.emitExpr(first)}))`;
  }
  if (expr.fn === "dc.hasSubscribers" && expr.args.length === 1 && first?.type.kind === "string") {
    return `runtime::diagnostics_has_subscribers::<${dyn}>(&(${context.emitExpr(first)}))`;
  }
  if ((expr.fn === "dc.subscribe" || expr.fn === "dc.unsubscribe") && expr.args.length === 2 &&
      first?.type.kind === "string" && second?.type.kind === "dyn") {
    const name = context.nextTemporary();
    const callback = context.nextTemporary();
    const action = expr.fn === "dc.subscribe"
      ? `runtime::diagnostics_subscribe(&${name}, ${callbackIdentity(callback)}, ${callback}); ()`
      : `runtime::diagnostics_unsubscribe::<${dyn}>(&${name}, ${callbackIdentity(callback)})`;
    return `{ let ${name} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; ${action} }`;
  }
  if (expr.fn === "dc.chanName" && expr.args.length === 1 && first?.type.kind === "f64") {
    return `runtime::diagnostics_chan_name::<${dyn}>(${context.emitExpr(first)})`;
  }
  if (expr.fn === "dc.chanHasSubscribers" && expr.args.length === 1 && first?.type.kind === "f64") {
    return `runtime::diagnostics_chan_has_subscribers::<${dyn}>(${context.emitExpr(first)})`;
  }
  if ((expr.fn === "dc.chanSubscribe" || expr.fn === "dc.chanUnsubscribe") && expr.args.length === 2 &&
      first?.type.kind === "f64" && second?.type.kind === "dyn") {
    const handle = context.nextTemporary();
    const callback = context.nextTemporary();
    const action = expr.fn === "dc.chanSubscribe"
      ? `runtime::diagnostics_chan_subscribe(${handle}, ${callbackIdentity(callback)}, ${callback}); ()`
      : `runtime::diagnostics_chan_unsubscribe::<${dyn}>(${handle}, ${callbackIdentity(callback)})`;
    return `{ let ${handle} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; ${action} }`;
  }
  if (expr.fn === "dc.publish" && expr.args.length === 2 &&
      first?.type.kind === "f64" && second?.type.kind === "dyn") {
    const handle = context.nextTemporary();
    const message = context.nextTemporary();
    const name = context.nextTemporary();
    const subscribers = context.nextTemporary();
    const callback = context.nextTemporary();
    return `{ let ${handle} = ${context.emitExpr(first)}; let ${message} = ${context.emitExpr(second)}; let (${name}, ${subscribers}) = runtime::diagnostics_snapshot::<${dyn}>(${handle}); for ${callback} in ${subscribers} { let _ = sc_dyn_call(&${callback}, &[${message}.clone(), ${dyn}::String(${name}.clone())], "subscription"); } () }`;
  }
  return null;
}
