export interface RustIslandValueContext {
  dynTypeName(): string;
}

export function emitIslandValue(value: string, context: RustIslandValueContext, depth = 0): string {
  const dyn = context.dynTypeName();
  // A checked-dynamic FUNCTION crossing into the realm (a callback whose
  // signature the typed host bridge cannot spell — an island-typed
  // parameter, a rest list): the engine gets a host function that hands
  // every argument back as a handle, calls the dyn function, and marshals
  // its result the same way an argument crosses. One level deep: a
  // callback answering a function is a boundary refusal.
  const callback = depth > 0
    ? `runtime::throw_error_code("a callback crossing into the island answered a function (nested callbacks stay island-side)".to_owned(), "SC3001")`
    // The host function carries the closure's declared arity: libraries
    // branch on `fn.length` (solid's `createRoot` only hands a disposer
    // to callbacks declaring one).
    : `{ let sc_callback = sc_value.clone(); runtime::island_value_host_function(` +
      `match sc_dyn_key_get(sc_value, &runtime::string("length"), false) { ${dyn}::Number(sc_n) => sc_n as usize, _ => 0 }, ` +
      `std::rc::Rc::new(move |sc_args| { ` +
      `let sc_dyn_args: Vec<${dyn}> = (0..sc_args.len()).map(|sc_i| sc_dyn_from_island(runtime::island_host_argument_value(sc_args, sc_i))).collect(); ` +
      `let sc_result = sc_dyn_call(&sc_callback, &sc_dyn_args, "callback"); ` +
      `match sc_result { ` +
      `${dyn}::Undefined => runtime::IslandHostResult::Undefined, ` +
      `${dyn}::Null => runtime::IslandHostResult::Null, ` +
      `${dyn}::Number(sc_v) => runtime::IslandHostResult::Number(sc_v), ` +
      `${dyn}::Boolean(sc_v) => runtime::IslandHostResult::Bool(sc_v), ` +
      `${dyn}::String(sc_v) => runtime::IslandHostResult::String(sc_v), ` +
      `${dyn}::Bytes(sc_v) | ${dyn}::Buffer(sc_v) => runtime::IslandHostResult::Bytes(runtime::island_bytes_values(&sc_v)), ` +
      `${dyn}::Island(sc_v) => runtime::IslandHostResult::Island(sc_v), ` +
      `sc_other => runtime::IslandHostResult::Island(${emitIslandValue("&sc_other", context, depth + 1)}), ` +
      `} })) }`;
  return `match ${value} { ` +
    `${dyn}::Undefined => runtime::island_value_undefined(), ` +
    `${dyn}::Null => runtime::island_value_null(), ` +
    `${dyn}::Number(sc_value) => runtime::island_value_number(*sc_value), ` +
    `${dyn}::Boolean(sc_value) => runtime::island_value_boolean(*sc_value), ` +
    `${dyn}::String(sc_value) => runtime::island_value_string(sc_value), ` +
    `${dyn}::Bytes(sc_value) | ${dyn}::Buffer(sc_value) => runtime::island_value_bytes(sc_value), ` +
    `${dyn}::Array(..) | ${dyn}::Object(..) => runtime::island_value_json(&runtime::json_stringify(${value})), ` +
    // A native RegExp crosses as its own source+flags, rebuilt by the
    // realm's RegExp constructor (the `z.string().regex(/^a+$/)` shape).
    // A fresh engine object per marshal: identity and lastIndex stay
    // host-side, exactly as SEMANTICS.md states for the C island.
    `${dyn}::Regex(sc_value) => runtime::island_value_regexp(` +
    `&runtime::regex_source(sc_value), &runtime::regex_flags(sc_value)), ` +
    // Match the C bridge's URL value-copy policy: reconstruct a realm URL
    // from the canonical native href, retaining its URL prototype/methods.
    `${dyn}::Url(sc_value) => runtime::island_construct(&runtime::island_global_get("URL"), ` +
    `&[runtime::island_value_string(&runtime::url_href(sc_value))]), ` +
    `${dyn}::Island(sc_value) => sc_value.clone(), ` +
    // A NATIVE promise (an async static callback's answer, a promise-
    // valued dyn) crosses as a pending engine promise the native one
    // settles: fulfillment marshals like an argument, rejection as an
    // engine Error carrying the reason's text. One level: a promise's
    // fulfillment is never itself a promise (JS flattens), so the nested
    // marshal keeps the plain arms only. Depth counts FUNCTION nesting:
    // a dyn callback's own answer (depth 1, the yargs middleware shape)
    // may be a promise; that promise's fulfillment (depth 2) may not.
    (depth <= 1
      ? `${dyn}::Promise(sc_handle) => { let (sc_island_promise, sc_island_resolve, sc_island_reject) = runtime::island_value_pending_promise(); ` +
        `let sc_native_promise = runtime::promise_from_handle::<${dyn}>(sc_handle); ` +
        `runtime::promise_then(&sc_native_promise, Box::new(move |sc_outcome| { match sc_outcome { ` +
        `Ok(sc_fulfilled) => { let _ = runtime::island_call(&sc_island_resolve, &[${emitIslandValue("&sc_fulfilled", context, depth + 1)}]); } ` +
        `Err(sc_reason) => { let _ = runtime::island_call(&sc_island_reject, &[runtime::island_value_error(&sc_reason)]); } } })); ` +
        `sc_island_promise }, `
      : "") +
    `sc_value if sc_dyn_typeof(sc_value).as_ref() == "function" => ${callback}, ` +
    `_ => runtime::throw_error_code("embedded module call argument is outside the JSON-safe island subset".to_owned(), "SC3001"), ` +
    `}`;
}
