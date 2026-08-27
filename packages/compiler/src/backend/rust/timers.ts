import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustTimerCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const callbackExpr = expr.args[0];
  if (expr.fn !== "timers.queueMicrotaskDyn" || expr.args.length !== 1 ||
      callbackExpr?.type.kind !== "dyn" || expr.type.kind !== "void") return null;
  const callback = context.nextTemporary();
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; if sc_dyn_function_identity(&${callback}).is_none() { sc_dyn_arg_type_fail("callback", "of type function", &${callback}); } runtime::timer_queue_microtask(Box::new(move || { let _ = sc_dyn_call(&${callback}, &[], "callback"); })); () }`;
}
