import type { RustDynamicHttpContext } from "./dynamic-http.js";

/** Web Streams share the checked-dynamic value representation with callbacks. */
export function emitRustDynamicWebStream(context: RustDynamicHttpContext): void {
  if (!context.usesDynamicInvoke()) return;
  const dyn = context.dynTypeName();
  const source = `
struct ScWebSource { receiver: ${dyn}, pull: ${dyn}, cancel: ${dyn} }
impl runtime::Trace for ScWebSource {
    fn trace(&self, tracer: &mut runtime::Tracer<'_>) {
        runtime::Trace::trace(&self.receiver, tracer);
        runtime::Trace::trace(&self.pull, tracer);
        runtime::Trace::trace(&self.cancel, tracer);
    }
}
fn sc_web_callback(receiver: &${dyn}, callback: &${dyn}, argument: ${dyn}, name: &str) -> runtime::JsPromise<${dyn}> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if matches!(callback, ${dyn}::Undefined) { ${dyn}::Undefined } else {
            let _guard = sc_dyn_this_push(receiver.clone());
            sc_dyn_call(callback, &[argument], name)
        }
    })) {
        Ok(${dyn}::Promise(handle)) => runtime::promise_from_handle::<${dyn}>(&handle),
        Ok(value) => runtime::promise_resolved(value),
        Err(payload) => runtime::promise_rejected(runtime::caught_from_panic(payload)),
    }
}
impl runtime::WebStreamSource<${dyn}> for ScWebSource {
    fn has_pull(&self) -> bool { !matches!(&self.pull, ${dyn}::Undefined) }
    fn pull(&self, stream: &runtime::JsWebStream<${dyn}>) -> runtime::JsPromise<${dyn}> {
        sc_web_callback(&self.receiver, &self.pull, ${dyn}::WebController(stream.clone()), "underlyingSource.pull")
    }
    fn cancel(&self, reason: ${dyn}) -> runtime::JsPromise<${dyn}> {
        sc_web_callback(&self.receiver, &self.cancel, reason, "underlyingSource.cancel")
    }
}
fn sc_web_stream_new(source: ${dyn}) -> ${dyn} {
    if !matches!(&source, ${dyn}::Undefined | ${dyn}::Object(..)) {
        sc_dyn_arg_type_fail("source", "of type object", &source);
    }
    let get = |key: &str| if matches!(&source, ${dyn}::Undefined) { ${dyn}::Undefined }
        else { sc_dyn_key_get(&source, &runtime::string(key), false) };
    let cancel = get("cancel");
    let pull = get("pull");
    let start = get("start");
    for (name, callback) in [("cancel", &cancel), ("pull", &pull), ("start", &start)] {
        if !matches!(callback, ${dyn}::Undefined) && sc_dyn_function_identity(callback).is_none() {
            sc_dyn_arg_type_fail(name, "of type function", callback);
        }
    }
    if !matches!(get("type"), ${dyn}::Undefined) {
        runtime::throw_type_error("Byte streams are not supported by static ReadableStream".to_owned());
    }
    let stream = runtime::web_stream_new(std::rc::Rc::new(ScWebSource { receiver: source.clone(), pull, cancel }));
    // Unlike pull/cancel, a synchronous exception from start escapes the constructor.
    let started = if matches!(&start, ${dyn}::Undefined) { ${dyn}::Undefined } else {
        let _guard = sc_dyn_this_push(source);
        sc_dyn_call(&start, &[${dyn}::WebController(stream.clone())], "underlyingSource.start")
    };
    let promise = match started {
        ${dyn}::Promise(handle) => runtime::promise_from_handle::<${dyn}>(&handle),
        value => runtime::promise_resolved(value),
    };
    runtime::web_stream_start(&stream, &promise);
    ${dyn}::WebStream(stream)
}
fn sc_web_stream_invoke(stream: &runtime::JsWebStream<${dyn}>, method: &str, args: &[${dyn}], name: &str) -> ${dyn} {
    match method {
        "getReader" => {
            if let Some(options) = args.first() {
                if !matches!(options, ${dyn}::Undefined) {
                    if !matches!(options, ${dyn}::Object(..) | ${dyn}::Null) { sc_dyn_arg_type_fail("options", "of type object", options); }
                    if !matches!(options, ${dyn}::Null) && !matches!(sc_dyn_key_get(options, &runtime::string("mode"), false), ${dyn}::Undefined) {
                        runtime::throw_type_error("BYOB readers are not supported".to_owned());
                    }
                }
            }
            ${dyn}::WebReader(runtime::web_stream_get_reader(stream))
        },
        "cancel" => ${dyn}::Promise(runtime::promise_to_mapped_handle(&runtime::web_stream_cancel(stream, args.first().cloned().unwrap_or(${dyn}::Undefined)), |_| ${dyn}::Undefined)),
        _ => runtime::throw_type_error(format!("{name} is not a function")),
    }
}
fn sc_web_reader_invoke(reader: &runtime::JsWebReader<${dyn}>, method: &str, args: &[${dyn}], name: &str) -> ${dyn} {
    match method {
        "read" => ${dyn}::Promise(runtime::promise_to_handle(&runtime::web_reader_read_with(reader, |chunk| {
            let result = runtime::map_new();
            runtime::map_set_by(&result, runtime::string("done"), ${dyn}::Boolean(chunk.is_none()), |a, b| a == b);
            runtime::map_set_by(&result, runtime::string("value"), chunk.unwrap_or(${dyn}::Undefined), |a, b| a == b);
            ${dyn}::Object(result)
        }))),
        "cancel" => ${dyn}::Promise(runtime::promise_to_mapped_handle(&runtime::web_reader_cancel(reader, args.first().cloned().unwrap_or(${dyn}::Undefined)), |_| ${dyn}::Undefined)),
        "releaseLock" => { runtime::web_reader_release(reader); ${dyn}::Undefined },
        _ => runtime::throw_type_error(format!("{name} is not a function")),
    }
}
fn sc_web_error(value: ${dyn}) -> runtime::Caught {
    if sc_dyn_error_instanceof(&value, "%Error") { runtime::caught_value(sc_dyn_error_unbox(value)) }
    else { runtime::caught_value(value) }
}
fn sc_web_controller_invoke(stream: &runtime::JsWebStream<${dyn}>, method: &str, args: &[${dyn}], name: &str) -> ${dyn} {
    match method {
        "enqueue" => runtime::web_stream_enqueue(stream, args.first().cloned().unwrap_or(${dyn}::Undefined)),
        "close" => runtime::web_stream_close(stream),
        "error" => runtime::web_stream_error(stream, sc_web_error(args.first().cloned().unwrap_or(${dyn}::Undefined))),
        _ => runtime::throw_type_error(format!("{name} is not a function")),
    }
    ${dyn}::Undefined
}
`;
  for (const line of source.trim().split("\n")) context.line(line);
}
