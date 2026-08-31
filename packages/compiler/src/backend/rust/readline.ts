import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustReadlineCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const stdinCall = emitRustStdinCall(expr, context);
  if (stdinCall !== null) return stdinCall;
  const [handle, query, callbackExpr] = expr.args;
  if (expr.fn === "rl.create" && expr.args.length === 0 && expr.type.kind === "f64") {
    return "runtime::readline_create()";
  }
  if (expr.fn === "rl.close" && expr.args.length === 1 && handle?.type.kind === "f64") {
    return `runtime::readline_close(${context.emitExpr(handle)})`;
  }
  if (expr.fn === "rl.nextLine" && expr.args.length === 1 &&
      handle?.type.kind === "f64" && expr.type.kind === "promise" &&
      expr.type.inner.kind === "union") {
    const union = context.union(expr.type.inner.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (union.arms.length !== 2 || stringTag < 0 || undefinedTag < 0) {
      context.unsupported("readline async iterator result shape", expr.loc);
    }
    const name = context.unionName(union.id);
    const handleValue = context.nextTemporary();
    const result = context.nextTemporary();
    const target = context.nextTemporary();
    return `{ let ${handleValue} = ${context.emitExpr(handle)}; let ${result}: runtime::JsPromise<${name}> = runtime::promise_new(); let ${target} = ${result}.clone(); runtime::readline_next_line(${handleValue}, Box::new(move |sc_line| { let sc_value = match sc_line { Some(sc_line) => ${name}::${context.unionVariant(stringTag)}(sc_line), None => ${name}::${context.unionVariant(undefinedTag)}, }; let _ = runtime::promise_fulfill(&${target}, sc_value); })); ${result} }`;
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

function emitRustStdinCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn !== "stdin.onData" && expr.fn !== "stdin.onEnd" && expr.fn !== "stdin.onError") {
    return null;
  }
  const [callbackExpr, onceExpr] = expr.args;
  if (callbackExpr?.type.kind !== "func" || callbackExpr.type.ret.kind !== "void" ||
      onceExpr?.type.kind !== "bool" || expr.type.kind !== "void") {
    context.unsupported(`${expr.fn} argument shape`, expr.loc);
  }
  const callbackType = callbackExpr.type;
  const callback = context.nextTemporary();
  const once = context.nextTemporary();
  if (expr.fn === "stdin.onEnd") {
    if (callbackType.params.length !== 0) context.unsupported("stdin end listener shape", expr.loc);
    const dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
    return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${once} = ${context.emitExpr(onceExpr)}; runtime::stdin_on_end(std::rc::Rc::new(move || { let _ = ${dispatch}; }), ${once}); }`;
  }
  if (callbackType.params.length > 1) context.unsupported(`${expr.fn} listener arity`, expr.loc);
  const parameter = callbackType.params[0];
  if (expr.fn === "stdin.onData") {
    if (parameter !== undefined && (parameter.kind !== "bytes" || parameter.elem !== "u8")) {
      context.unsupported("stdin data listener shape", expr.loc);
    }
    const chunk = parameter === undefined ? "_sc_chunk" : "sc_chunk";
    const dispatch = context.emitClosureDispatch(callback, callbackType, parameter === undefined ? [] : [chunk], expr.loc);
    return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${once} = ${context.emitExpr(onceExpr)}; runtime::stdin_on_data(std::rc::Rc::new(move |${chunk}| { let _ = ${dispatch}; }), ${once}); }`;
  }
  if (parameter !== undefined && (parameter.kind !== "object" || parameter.className !== "%Error")) {
    context.unsupported("stdin error listener shape", expr.loc);
  }
  const error = parameter === undefined ? "_sc_error" : "sc_error";
  const argument = context.hasErrorClassRoots()
    ? `${context.errorValueName()}::Builtin(sc_error)`
    : "sc_error";
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : [argument],
    expr.loc,
  );
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${once} = ${context.emitExpr(onceExpr)}; runtime::stdin_on_error(std::rc::Rc::new(move |${error}| { let _ = ${dispatch}; }), ${once}); }`;
}
