import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustPromiseView(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn !== "promise.view") return null;
  const source = expr.args[0];
  const map = expr.args[1];
  if (!source || map?.kind !== "closure" || map.captures.length !== 0 || map.type.kind !== "func") {
    return context.unsupported("promise.view payload conversion", expr.loc);
  }
  const promise = context.nextTemporary();
  const mapper = context.nextTemporary();
  const invoke = context.emitClosureDispatch(mapper, map.type, ["sc_payload"], expr.loc);
  return `{ let ${promise} = ${context.emitExpr(source)}; let ${mapper} = ${context.emitExpr(map)}; runtime::promise_view_map(&${promise}, move |sc_payload| ${invoke}) }`;
}
