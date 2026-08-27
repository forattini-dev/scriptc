import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustReadlineCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const [handle, query, callbackExpr] = expr.args;
  if (expr.fn === "rl.create" && expr.args.length === 0 && expr.type.kind === "f64") {
    return "runtime::readline_create()";
  }
  if (expr.fn === "rl.close" && expr.args.length === 1 && handle?.type.kind === "f64") {
    return `runtime::readline_close(${context.emitExpr(handle)})`;
  }
  if (expr.fn === "rl.onClose" && expr.args.length === 2 &&
      handle?.type.kind === "f64" && query?.type.kind === "func" &&
      query.type.params.length === 0 && query.type.ret.kind === "void") {
    const handleValue = context.nextTemporary();
    const callback = context.nextTemporary();
    const dispatch = context.emitClosureDispatch(callback, query.type, [], expr.loc);
    return `{ let ${handleValue} = ${context.emitExpr(handle)}; let ${callback} = ${context.emitExpr(query)}; runtime::readline_on_close(${handleValue}, Box::new(move || { let _ = ${dispatch}; })); }`;
  }
  if (expr.fn === "rl.question" && expr.args.length === 3 &&
      handle?.type.kind === "f64" && query?.type.kind === "string" &&
      callbackExpr?.type.kind === "func" && callbackExpr.type.params.length <= 1 &&
      callbackExpr.type.ret.kind === "void") {
    const parameter = callbackExpr.type.params[0];
    if (parameter !== undefined && parameter.kind !== "string") {
      context.unsupported("readline question callback shape", expr.loc);
    }
    const handleValue = context.nextTemporary();
    const queryValue = context.nextTemporary();
    const callback = context.nextTemporary();
    const answer = parameter === undefined ? "_sc_answer" : "sc_answer";
    const dispatch = context.emitClosureDispatch(
      callback,
      callbackExpr.type,
      parameter === undefined ? [] : [answer],
      expr.loc,
    );
    return `{ let ${handleValue} = ${context.emitExpr(handle)}; let ${queryValue} = ${context.emitExpr(query)}; let ${callback} = ${context.emitExpr(callbackExpr)}; runtime::readline_question(${handleValue}, &${queryValue}, Box::new(move |${answer}| { let _ = ${dispatch}; })); }`;
  }
  return null;
}
