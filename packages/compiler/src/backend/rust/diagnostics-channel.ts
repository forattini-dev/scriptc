import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

function callbackIdentity(value: string): string {
  return `sc_dyn_function_identity(&${value}).unwrap_or_else(|| sc_dyn_arg_type_fail("subscription", "of type function", &${value}))`;
}

const TRACE_EVENTS = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;

function traceEventChannel(handle: string, index: number, dyn: string): string {
  return `runtime::diagnostics_tracing_event_channel::<${dyn}>(${handle}, ${index}.0)`;
}

function emitPublish(
  handle: string,
  message: string,
  dyn: string,
  context: RustLibCallContext,
): string {
  const name = context.nextTemporary();
  const subscribers = context.nextTemporary();
  const callback = context.nextTemporary();
  return `{ let (${name}, ${subscribers}) = runtime::diagnostics_snapshot::<${dyn}>(${handle}); for ${callback} in ${subscribers} { let _ = sc_dyn_call(&${callback}, &[${message}.clone(), ${dyn}::String(${name}.clone())], "subscription"); } }`;
}

function emitTracingSubscription(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
  subscribe: boolean,
): string | null {
  const [handleExpr, handlersExpr] = expr.args;
  if (handleExpr?.type.kind !== "f64" || handlersExpr?.type.kind !== "dyn") return null;
  const dyn = context.dynTypeName();
  const handle = context.nextTemporary();
  const handlers = context.nextTemporary();
  const done = context.nextTemporary();
  const actions = TRACE_EVENTS.map((event, index) => {
    const callback = context.nextTemporary();
    const channel = traceEventChannel(handle, index, dyn);
    const action = subscribe
      ? `runtime::diagnostics_chan_subscribe(${channel}, ${callbackIdentity(callback)}, ${callback});`
      : `if !runtime::diagnostics_chan_unsubscribe::<${dyn}>(${channel}, ${callbackIdentity(callback)}) { ${done} = false; }`;
    return `let ${callback} = sc_dyn_key_get(&${handlers}, &runtime::string("${event}"), false); if sc_dyn_is_truthy(&${callback}) { ${action} }`;
  }).join(" ");
  return `{ let ${handle} = ${context.emitExpr(handleExpr)}; let ${handlers} = ${context.emitExpr(handlersExpr)}; let mut ${done} = true; ${actions} ${subscribe ? "()" : done} }`;
}

function emitTraceSync(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  const [handleExpr, fnExpr, contextExpr, thisExpr, argsExpr] = expr.args;
  if (handleExpr?.type.kind !== "f64" || fnExpr?.type.kind !== "dyn" ||
      contextExpr?.type.kind !== "dyn" || thisExpr?.type.kind !== "dyn" || argsExpr?.type.kind !== "dyn") return null;
  const dyn = context.dynTypeName();
  const handle = context.nextTemporary();
  const fn = context.nextTemporary();
  const traceContext = context.nextTemporary();
  const thisArg = context.nextTemporary();
  const args = context.nextTemporary();
  const callArgs = context.nextTemporary();
  const index = context.nextTemporary();
  const outcome = context.nextTemporary();
  const result = context.nextTemporary();
  const payload = context.nextTemporary();
  const caught = context.nextTemporary();
  const error = context.nextTemporary();
  const collectArgs = `let mut ${callArgs} = Vec::new(); if let ${dyn}::Array(sc_values) = &${args} { let mut ${index} = 0.0; while ${index} < runtime::array_len(sc_values) { ${callArgs}.push(runtime::array_get(sc_values, ${index})); ${index} += 1.0; } }`;
  const invoke = `{ let _sc_this_guard = sc_dyn_this_push(${thisArg}.clone()); sc_dyn_call(&${fn}, &${callArgs}, "traceSync") }`;
  const setResult = `if let ${dyn}::Object(sc_object) = &${traceContext} { runtime::map_set_by(sc_object, runtime::string("result"), ${result}.clone(), |left, right| left.as_ref() == right.as_ref()); }`;
  const setError = `if let ${dyn}::Object(sc_object) = &${traceContext} { runtime::map_set_by(sc_object, runtime::string("error"), ${error}, |left, right| left.as_ref() == right.as_ref()); }`;
  const publishStart = emitPublish(traceEventChannel(handle, 0, dyn), traceContext, dyn, context);
  const publishEnd = emitPublish(traceEventChannel(handle, 1, dyn), traceContext, dyn, context);
  const publishError = emitPublish(traceEventChannel(handle, 4, dyn), traceContext, dyn, context);
  return `{ let ${handle} = ${context.emitExpr(handleExpr)}; let ${fn} = ${context.emitExpr(fnExpr)}; let ${traceContext} = ${context.emitExpr(contextExpr)}; let ${thisArg} = ${context.emitExpr(thisExpr)}; let ${args} = ${context.emitExpr(argsExpr)}; ${collectArgs} if !runtime::diagnostics_tracing_has_subscribers::<${dyn}>(${handle}) { ${invoke} } else { ${publishStart}; let ${outcome} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${invoke})); match ${outcome} { Ok(${result}) => { ${setResult} ${publishEnd}; ${result} }, Err(${payload}) => { let ${caught} = runtime::caught_from_panic(${payload}); let ${error} = sc_dyn_from_caught(${caught}.clone()); ${setError} ${publishError}; ${publishEnd}; runtime::rethrow_caught(${caught}) }, } } }`;
}

function emitTraceCallback(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  const [handleExpr, fnExpr, positionExpr, contextExpr, thisExpr, argsExpr] = expr.args;
  if (handleExpr?.type.kind !== "f64" || fnExpr?.type.kind !== "dyn" || positionExpr?.type.kind !== "f64" ||
      contextExpr?.type.kind !== "dyn" || thisExpr?.type.kind !== "dyn" || argsExpr?.type.kind !== "dyn") return null;
  const dyn = context.dynTypeName();
  const handle = context.nextTemporary();
  const traceContext = context.nextTemporary();
  const args = context.nextTemporary();
  const callArgs = context.nextTemporary();
  const index = context.nextTemporary();
  const callback = context.nextTemporary();
  const tail = context.nextTemporary();
  const asyncContext = context.nextTemporary();
  const asyncCallback = context.nextTemporary();
  const error = context.nextTemporary();
  const result = context.nextTemporary();
  const outcome = context.nextTemporary();
  const payload = context.nextTemporary();
  const caught = context.nextTemporary();
  const collectArgs = `let mut ${callArgs} = Vec::new(); if let ${dyn}::Array(sc_values) = &${args} { let mut ${index} = 0.0; while ${index} < runtime::array_len(sc_values) { ${callArgs}.push(runtime::array_get(sc_values, ${index})); ${index} += 1.0; } }`;
  const validate = `let ${callback} = ${callArgs}.first().cloned().unwrap_or(${dyn}::Undefined); if sc_dyn_function_identity(&${callback}).is_none() { sc_dyn_arg_type_fail("callback", "of type function", &${callback}); }`;
  const directSchedule = `let ${tail}: Vec<${dyn}> = ${callArgs}.iter().skip(1).cloned().collect(); runtime::timer_set_immediate(Box::new(move || { let _sc_this_guard = sc_dyn_this_push(${dyn}::Undefined); let _ = sc_dyn_call(&${callback}, &${tail}, "immediate callback"); })); ${dyn}::Undefined`;
  if (fnExpr.kind !== "libCall" || fnExpr.fn !== "timers.setImmediateFnValue" ||
      positionExpr.kind !== "numLit" || positionExpr.value !== 0) {
    const fn = context.nextTemporary();
    return `{ let ${handle} = ${context.emitExpr(handleExpr)}; let ${fn} = ${context.emitExpr(fnExpr)}; let ${traceContext} = ${context.emitExpr(contextExpr)}; let _sc_this_arg = ${context.emitExpr(thisExpr)}; let ${args} = ${context.emitExpr(argsExpr)}; ${collectArgs} ${validate} let _ = (${handle}, ${fn}, ${traceContext}); runtime::throw_error_code("Rust traceCallback currently supports setImmediate as the traced function".to_owned(), "SC2020") }`;
  }
  const publishStart = emitPublish(traceEventChannel(handle, 0, dyn), traceContext, dyn, context);
  const publishEnd = emitPublish(traceEventChannel(handle, 1, dyn), traceContext, dyn, context);
  const publishError = emitPublish(traceEventChannel(handle, 4, dyn), asyncContext, dyn, context);
  const publishAsyncStart = emitPublish(traceEventChannel(handle, 2, dyn), asyncContext, dyn, context);
  const publishAsyncEnd = emitPublish(traceEventChannel(handle, 3, dyn), asyncContext, dyn, context);
  const setError = `if let ${dyn}::Object(sc_object) = &${asyncContext} { runtime::map_set_by(sc_object, runtime::string("error"), ${error}.clone(), |left, right| left.as_ref() == right.as_ref()); }`;
  const setResult = `if let ${dyn}::Object(sc_object) = &${asyncContext} { runtime::map_set_by(sc_object, runtime::string("result"), ${result}.clone(), |left, right| left.as_ref() == right.as_ref()); }`;
  const scheduleWrapped = `let ${tail}: Vec<${dyn}> = ${callArgs}.iter().skip(1).cloned().collect(); let ${asyncContext} = ${traceContext}.clone(); let ${asyncCallback} = ${callback}.clone(); runtime::timer_set_immediate(Box::new(move || { let ${error} = ${tail}.first().cloned().unwrap_or(${dyn}::Undefined); let ${result} = ${tail}.get(1).cloned().unwrap_or(${dyn}::Undefined); if sc_dyn_is_truthy(&${error}) { ${setError} ${publishError}; } else { ${setResult} } ${publishAsyncStart}; let ${outcome} = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _sc_this_guard = sc_dyn_this_push(${dyn}::Undefined); sc_dyn_call(&${asyncCallback}, &${tail}, "callback") })) { Ok(value) => Ok(value), Err(${payload}) => Err(runtime::caught_from_panic(${payload})), }; ${publishAsyncEnd}; if let Err(${caught}) = ${outcome} { runtime::rethrow_caught(${caught}); } }));`;
  return `{ let ${handle} = ${context.emitExpr(handleExpr)}; let ${traceContext} = ${context.emitExpr(contextExpr)}; let _sc_this_arg = ${context.emitExpr(thisExpr)}; let ${args} = ${context.emitExpr(argsExpr)}; ${collectArgs} ${validate} if !runtime::diagnostics_tracing_has_subscribers::<${dyn}>(${handle}) { ${directSchedule} } else { ${publishStart}; ${scheduleWrapped} ${publishEnd}; ${dyn}::Undefined } }`;
}

function emitTracePromise(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  const [handleExpr, fnExpr, contextExpr, thisExpr, argsExpr] = expr.args;
  if (handleExpr?.type.kind !== "f64" || fnExpr?.type.kind !== "dyn" ||
      contextExpr?.type.kind !== "dyn" || thisExpr?.type.kind !== "dyn" || argsExpr?.type.kind !== "dyn") return null;
  const dyn = context.dynTypeName();
  const handle = context.nextTemporary();
  const fn = context.nextTemporary();
  const traceContext = context.nextTemporary();
  const thisArg = context.nextTemporary();
  const args = context.nextTemporary();
  const callArgs = context.nextTemporary();
  const index = context.nextTemporary();
  const invocation = context.nextTemporary();
  const result = context.nextTemporary();
  const payload = context.nextTemporary();
  const caught = context.nextTemporary();
  const error = context.nextTemporary();
  const source = context.nextTemporary();
  const target = context.nextTemporary();
  const reactionTarget = context.nextTemporary();
  const reactionContext = context.nextTemporary();
  const outcome = context.nextTemporary();
  const publishResult = context.nextTemporary();
  const publishPayload = context.nextTemporary();
  const publishCaught = context.nextTemporary();
  const collectArgs = `let mut ${callArgs} = Vec::new(); if let ${dyn}::Array(sc_values) = &${args} { let mut ${index} = 0.0; while ${index} < runtime::array_len(sc_values) { ${callArgs}.push(runtime::array_get(sc_values, ${index})); ${index} += 1.0; } }`;
  const invoke = `{ let _sc_this_guard = sc_dyn_this_push(${thisArg}.clone()); sc_dyn_call(&${fn}, &${callArgs}, "tracePromise") }`;
  const adopt = `match ${result} { ${dyn}::Promise(sc_handle) => runtime::promise_from_handle::<${dyn}>(&sc_handle), sc_value => runtime::promise_resolved(sc_value), }`;
  const setSyncError = `if let ${dyn}::Object(sc_object) = &${traceContext} { runtime::map_set_by(sc_object, runtime::string("error"), ${error}, |left, right| left.as_ref() == right.as_ref()); }`;
  const publishStart = emitPublish(traceEventChannel(handle, 0, dyn), traceContext, dyn, context);
  const publishEnd = emitPublish(traceEventChannel(handle, 1, dyn), traceContext, dyn, context);
  const publishSyncError = emitPublish(traceEventChannel(handle, 4, dyn), traceContext, dyn, context);
  const publishError = emitPublish(traceEventChannel(handle, 4, dyn), reactionContext, dyn, context);
  const publishAsyncStart = emitPublish(traceEventChannel(handle, 2, dyn), reactionContext, dyn, context);
  const publishAsyncEnd = emitPublish(traceEventChannel(handle, 3, dyn), reactionContext, dyn, context);
  const settleReaction = `match ${outcome} { Ok(sc_value) => { if let ${dyn}::Object(sc_object) = &${reactionContext} { runtime::map_set_by(sc_object, runtime::string("result"), sc_value.clone(), |left, right| left.as_ref() == right.as_ref()); } let ${publishResult} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { ${publishAsyncStart}; ${publishAsyncEnd}; })); match ${publishResult} { Ok(()) => { let _ = runtime::promise_fulfill(&${reactionTarget}, sc_value); }, Err(${publishPayload}) => { let _ = runtime::promise_reject(&${reactionTarget}, runtime::caught_from_panic(${publishPayload})); }, } }, Err(sc_reason) => { if let ${dyn}::Object(sc_object) = &${reactionContext} { runtime::map_set_by(sc_object, runtime::string("error"), sc_dyn_from_caught(sc_reason.clone()), |left, right| left.as_ref() == right.as_ref()); } let ${publishResult} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { ${publishError}; ${publishAsyncStart}; ${publishAsyncEnd}; })); match ${publishResult} { Ok(()) => { let _ = runtime::promise_reject(&${reactionTarget}, sc_reason); }, Err(${publishPayload}) => { let ${publishCaught} = runtime::caught_from_panic(${publishPayload}); let _ = runtime::promise_reject(&${reactionTarget}, ${publishCaught}); }, } } }`;
  const traced = `{ let ${invocation} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${invoke})); let ${result} = match ${invocation} { Ok(value) => value, Err(${payload}) => { let ${caught} = runtime::caught_from_panic(${payload}); let ${error} = sc_dyn_from_caught(${caught}.clone()); ${setSyncError} ${publishSyncError}; ${publishEnd}; runtime::rethrow_caught(${caught}) }, }; let ${source}: runtime::JsPromise<${dyn}> = ${adopt}; let ${target}: runtime::JsPromise<${dyn}> = runtime::promise_new(); let ${reactionTarget} = ${target}.clone(); let ${reactionContext} = ${traceContext}.clone(); runtime::promise_then(&${source}, Box::new(move |${outcome}| { ${settleReaction} })); ${publishEnd}; ${target} }`;
  return `{ let ${handle} = ${context.emitExpr(handleExpr)}; let ${fn} = ${context.emitExpr(fnExpr)}; let ${traceContext} = ${context.emitExpr(contextExpr)}; let ${thisArg} = ${context.emitExpr(thisExpr)}; let ${args} = ${context.emitExpr(argsExpr)}; ${collectArgs} if !runtime::diagnostics_tracing_has_subscribers::<${dyn}>(${handle}) { let ${result} = ${invoke}; ${adopt} } else { ${publishStart}; ${traced} } }`;
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
  if (expr.fn === "dc.tracingChannel" && expr.args.length === 1 && first?.type.kind === "string") {
    return `runtime::diagnostics_tracing_channel::<${dyn}>(&(${context.emitExpr(first)}))`;
  }
  if (expr.fn === "dc.tracingChannelOf" && expr.args.length === 5 &&
      expr.args.every((arg) => arg.type.kind === "f64")) {
    return `runtime::diagnostics_tracing_channel_of::<${dyn}>([${expr.args.map((arg) => context.emitExpr(arg)).join(", ")}])`;
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
  if (expr.fn === "dc.tcChannel" && expr.args.length === 2 &&
      first?.type.kind === "f64" && second?.type.kind === "f64") {
    return `runtime::diagnostics_tracing_event_channel::<${dyn}>(${context.emitExpr(first)}, ${context.emitExpr(second)})`;
  }
  if (expr.fn === "dc.tcHasSubscribers" && expr.args.length === 1 && first?.type.kind === "f64") {
    return `runtime::diagnostics_tracing_has_subscribers::<${dyn}>(${context.emitExpr(first)})`;
  }
  if ((expr.fn === "dc.tcSubscribe" || expr.fn === "dc.tcUnsubscribe") && expr.args.length === 2) {
    return emitTracingSubscription(expr, context, expr.fn === "dc.tcSubscribe");
  }
  if (expr.fn === "dc.tcTraceSync" && expr.args.length === 5) {
    return emitTraceSync(expr, context);
  }
  if (expr.fn === "dc.tcTraceCallback" && expr.args.length === 6) {
    return emitTraceCallback(expr, context);
  }
  if (expr.fn === "dc.tcTracePromise" && expr.args.length === 5) {
    return emitTracePromise(expr, context);
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
