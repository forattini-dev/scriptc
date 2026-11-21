// Native erased Map operations retain owning handles; no source execution.
fn native_value_same_key(a: &NativeValue, b: &NativeValue) -> bool {
    native_value_eq(a, b)
        || matches!((a,b), (NativeValue::Number(a), NativeValue::Number(b)) if a.is_nan() && b.is_nan())
}
fn native_map_key(key: NativeValue) -> NativeValue {
    match key {
        NativeValue::Number(n) if n == 0.0 => NativeValue::Number(0.0),
        key => key,
    }
}
fn native_value_key_hash(key: &NativeValue) -> Option<u64> {
    match key {
        NativeValue::Undefined => Some(native_hash_key(&0_u8)),
        NativeValue::Null => Some(native_hash_key(&1_u8)),
        NativeValue::Boolean(value) => Some(native_hash_key(&(2_u8, value))),
        NativeValue::Number(value) => Some(native_number_key_hash(*value) ^ 3),
        NativeValue::String(value) => Some(native_hash_key(value) ^ 4),
        _ => None,
    }
}
fn native_bind(target: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    if !native_value_is_function(&target) {
        runtime::throw_type_error("Bind must be called on a function".into());
    }
    let mut values = vec![
        target,
        args.first().cloned().unwrap_or(NativeValue::Undefined),
    ];
    values.extend(args.into_iter().skip(1));
    NativeValue::Bound(runtime::array_new(values))
}
struct NativeReadableStreamSource {
    source: NativeValue,
    pull: bool,
    cancel: bool,
}
impl runtime::Trace for NativeReadableStreamSource {
    fn trace(&self, tracer: &mut runtime::Tracer<'_>) {
        self.source.trace_native(tracer);
    }
}
impl runtime::WebStreamSource<runtime::JsBytes<u8>> for NativeReadableStreamSource {
    fn pull(
        &self,
        stream: &runtime::JsWebStream<runtime::JsBytes<u8>>,
    ) -> runtime::JsPromise<runtime::JsBytes<u8>> {
        if !self.pull {
            return runtime::promise_resolved(runtime::bytes_empty());
        }
        let callback = native_value_get(self.source.clone(), runtime::string("pull"));
        let result = native_value_call_with_this(
            callback,
            self.source.clone(),
            vec![NativeValue::WebBytesController(stream.clone())],
            "ReadableStream pull",
        );
        match result {
            NativeValue::Promise(promise) => {
                runtime::promise_view_map(&promise, |_| runtime::bytes_empty())
            }
            _ => runtime::promise_resolved(runtime::bytes_empty()),
        }
    }
    fn cancel(&self, reason: runtime::JsBytes<u8>) -> runtime::JsPromise<runtime::JsBytes<u8>> {
        if !self.cancel {
            return runtime::promise_resolved(runtime::bytes_empty());
        }
        let callback = native_value_get(self.source.clone(), runtime::string("cancel"));
        let result = native_value_call_with_this(
            callback,
            self.source.clone(),
            vec![NativeValue::ArrayBuffer(reason)],
            "ReadableStream cancel",
        );
        match result {
            NativeValue::Promise(promise) => {
                runtime::promise_view_map(&promise, |_| runtime::bytes_empty())
            }
            _ => runtime::promise_resolved(runtime::bytes_empty()),
        }
    }
    fn has_pull(&self) -> bool {
        self.pull
    }
}
fn native_readable_stream_new(source: NativeValue) -> NativeValue {
    if matches!(source, NativeValue::Undefined | NativeValue::Null) {
        return NativeValue::WebBytesStream(runtime::web_stream_manual());
    }
    let start = native_value_get(source.clone(), runtime::string("start"));
    let pull = native_value_get(source.clone(), runtime::string("pull"));
    let cancel = native_value_get(source.clone(), runtime::string("cancel"));
    for (name, callback) in [("start", &start), ("pull", &pull), ("cancel", &cancel)] {
        if !matches!(callback, NativeValue::Undefined) && !native_value_is_function(callback) {
            runtime::throw_type_error(format!("ReadableStream {name} must be callable"));
        }
    }
    let stream = runtime::web_stream_new(std::rc::Rc::new(NativeReadableStreamSource {
        source: source.clone(),
        pull: !matches!(pull, NativeValue::Undefined),
        cancel: !matches!(cancel, NativeValue::Undefined),
    }));
    let started = if matches!(start, NativeValue::Undefined) {
        runtime::promise_resolved(runtime::bytes_empty())
    } else {
        match native_value_call_with_this(
            start,
            source,
            vec![NativeValue::WebBytesController(stream.clone())],
            "ReadableStream start",
        ) {
            NativeValue::Promise(promise) => {
                runtime::promise_view_map(&promise, |_| runtime::bytes_empty())
            }
            _ => runtime::promise_resolved(runtime::bytes_empty()),
        }
    };
    runtime::web_stream_start(&stream, &started);
    NativeValue::WebBytesStream(stream)
}
fn native_value_method(recv: NativeValue, method: &str) -> NativeValue {
    if native_dom_event_method(&recv, method) || native_emitter_method(&recv, method) {
        return recv;
    }
    if native_value_is_async_generator(&recv) && matches!(method, "next" | "return") {
        return recv;
    }
    if matches!(&recv, NativeValue::ArrayIterator(_)) && method == "next" {
        return recv;
    }
    if native_value_is_array(&recv) && method == "sort" {
        return recv;
    }
    if matches!(&recv, NativeValue::Number(_))
        && matches!(
            method,
            "toString" | "toFixed" | "toExponential" | "toPrecision" | "valueOf"
        )
    {
        return recv;
    }
    if matches!(&recv, NativeValue::BigInt(_) | NativeValue::String(_))
        && matches!(method, "toString" | "valueOf")
    {
        return recv;
    }
    if native_value_is_function(&recv) && matches!(method, "call" | "apply" | "bind") {
        return recv;
    }
    if matches!(&recv, NativeValue::Promise(_)) && matches!(method, "then" | "catch" | "finally") {
        return recv;
    }
    if matches!(&recv, NativeValue::HttpResponse(_)) && matches!(method, "text" | "arrayBuffer") {
        return recv;
    }
    if matches!(&recv, NativeValue::Headers(_))
        && matches!(
            method,
            "get" | "has" | "append" | "set" | "delete" | "forEach"
        )
    {
        return recv;
    }
    if matches!(&recv, NativeValue::Date(_))
        && matches!(
            method,
            "toString"
                | "toISOString"
                | "getTime"
                | "valueOf"
                | "getFullYear"
                | "getUTCFullYear"
                | "getMonth"
                | "getUTCMonth"
                | "getDate"
                | "getUTCDate"
                | "getDay"
                | "getUTCDay"
                | "getHours"
                | "getUTCHours"
                | "getMinutes"
                | "getUTCMinutes"
                | "getSeconds"
                | "getUTCSeconds"
                | "getMilliseconds"
                | "getUTCMilliseconds"
                | "getTimezoneOffset"
        )
    {
        return recv;
    }
    if matches!(&recv, NativeValue::WebBytesStream(_))
        && matches!(method, "getReader" | "pipeThrough")
    {
        return recv;
    }
    if matches!(&recv, NativeValue::WebBytesReader(_))
        && matches!(method, "read" | "cancel" | "releaseLock")
    {
        return recv;
    }
    if matches!(&recv, NativeValue::WebBytesController(_))
        && matches!(method, "enqueue" | "close" | "error")
    {
        return recv;
    }
    if matches!(&recv, NativeValue::WebTextStream(_)) && method == "getReader" {
        return recv;
    }
    if matches!(&recv, NativeValue::WebTextReader(_))
        && matches!(method, "read" | "cancel" | "releaseLock")
    {
        return recv;
    }
    if matches!(&recv, NativeValue::Map(_))
        && matches!(method, "get" | "set" | "has" | "delete" | "clear")
    {
        recv
    } else {
        native_value_get(recv, method.into())
    }
}
fn native_value_invoke(
    holder: NativeValue,
    recv: NativeValue,
    method: &str,
    args: Vec<NativeValue>,
    name: &str,
) -> NativeValue {
    if let Some(value) = native_dom_event_invoke(&recv, method) {
        return value;
    }
    if let Some(value) = native_emitter_invoke(&recv, method, &args) {
        return value;
    }
    if native_value_is_async_generator(&recv) {
        return native_value_async_generator_invoke(recv, method, args);
    }
    if let NativeValue::ArrayIterator(iterator) = &recv {
        if method != "next" {
            runtime::throw_type_error(format!("{} is not a function", name));
        }
        return match runtime::array_iterator_next_or(iterator, NativeValue::Undefined) {
            Some(runtime::ArrayIteratorItem::Value(value)) => native_iterator_result(value, false),
            Some(runtime::ArrayIteratorItem::Key(key)) => {
                native_iterator_result(NativeValue::Number(key), false)
            }
            Some(runtime::ArrayIteratorItem::Entry(key, value)) => native_iterator_result(
                NativeValue::Array(runtime::array_new(vec![NativeValue::Number(key), value])),
                false,
            ),
            None => native_iterator_result(NativeValue::Undefined, true),
        };
    }
    if method == "sort" && native_value_is_array(&holder) {
        return match args.first() {
            None | Some(NativeValue::Undefined) => native_value_sort_default(holder),
            Some(comparator) if native_value_is_function(comparator) => {
                native_value_sort_with(holder, comparator.clone())
            }
            _ => runtime::throw_type_error(
                "The comparison function must be either a function or undefined".into(),
            ),
        };
    }
    if let NativeValue::Number(value) = &recv {
        let argument = |default: f64| match args.first() {
            None | Some(NativeValue::Undefined) => default,
            Some(value) => native_compare_number(value),
        };
        return match method {
            "valueOf" => recv,
            "toString" => {
                NativeValue::String(runtime::number_to_radix_string(*value, argument(10.0)))
            }
            "toFixed" => NativeValue::String(runtime::number_to_fixed(*value, argument(0.0))),
            "toExponential" => NativeValue::String(match args.first() {
                None | Some(NativeValue::Undefined) => runtime::number_to_exponential(*value),
                Some(_) => runtime::number_to_exponential_digits(*value, argument(0.0)),
            }),
            "toPrecision" => NativeValue::String(match args.first() {
                None | Some(NativeValue::Undefined) => {
                    runtime::number_to_radix_string(*value, 10.0)
                }
                Some(_) => runtime::number_to_precision(*value, argument(1.0)),
            }),
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if matches!(&recv, NativeValue::String(_)) && matches!(method, "toString" | "valueOf") {
        // String.prototype.toString/valueOf return the primitive itself.
        return recv;
    }
    if let NativeValue::BigInt(value) = &recv {
        return match method {
            "valueOf" => recv,
            "toString" => {
                let radix = match args.first() {
                    None | Some(NativeValue::Undefined) => 10.0,
                    Some(value) => native_compare_number(value),
                };
                NativeValue::String(runtime::bigint_to_string_radix(value, radix))
            }
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if let NativeValue::Date(value) = &recv {
        let milliseconds = runtime::date_value_time(value);
        return match method {
            "toString" => NativeValue::String(runtime::date_value_to_string(value)),
            "toISOString" => NativeValue::String(runtime::date_to_iso(milliseconds)),
            "getTime" | "valueOf" => NativeValue::Number(milliseconds),
            "getFullYear" => NativeValue::Number(runtime::date_get_full_year(milliseconds, false)),
            "getUTCFullYear" => {
                NativeValue::Number(runtime::date_get_full_year(milliseconds, true))
            }
            "getMonth" => NativeValue::Number(runtime::date_get_month(milliseconds, false)),
            "getUTCMonth" => NativeValue::Number(runtime::date_get_month(milliseconds, true)),
            "getDate" => NativeValue::Number(runtime::date_get_date(milliseconds, false)),
            "getUTCDate" => NativeValue::Number(runtime::date_get_date(milliseconds, true)),
            "getDay" => NativeValue::Number(runtime::date_get_day(milliseconds, false)),
            "getUTCDay" => NativeValue::Number(runtime::date_get_day(milliseconds, true)),
            "getHours" => NativeValue::Number(runtime::date_get_hours(milliseconds, false)),
            "getUTCHours" => NativeValue::Number(runtime::date_get_hours(milliseconds, true)),
            "getMinutes" => NativeValue::Number(runtime::date_get_minutes(milliseconds, false)),
            "getUTCMinutes" => NativeValue::Number(runtime::date_get_minutes(milliseconds, true)),
            "getSeconds" => NativeValue::Number(runtime::date_get_seconds(milliseconds, false)),
            "getUTCSeconds" => NativeValue::Number(runtime::date_get_seconds(milliseconds, true)),
            "getMilliseconds" | "getUTCMilliseconds" => {
                NativeValue::Number(runtime::date_get_milliseconds(milliseconds))
            }
            "getTimezoneOffset" => {
                NativeValue::Number(runtime::date_get_timezone_offset(milliseconds))
            }
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if let NativeValue::WebBytesStream(stream) = &recv {
        return match method {
            "getReader" if args.is_empty() => {
                NativeValue::WebBytesReader(runtime::web_stream_get_reader(stream))
            }
            "pipeThrough" if args.len() == 1 => match &args[0] {
                NativeValue::TextDecoderStream(decoder) => {
                    NativeValue::WebTextStream(runtime::web_text_decoder_stream(stream, *decoder))
                }
                _ => runtime::throw_type_error(
                    "ReadableStream.pipeThrough requires a native TransformStream".into(),
                ),
            },
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if let NativeValue::WebBytesReader(reader) = &recv {
        return match method {
            "read" if args.is_empty() => {
                let source = runtime::web_reader_read(reader);
                NativeValue::Promise(runtime::promise_view_map(&source, native_web_read_result))
            }
            "cancel" => {
                let source = runtime::web_reader_cancel(reader, runtime::bytes_empty::<u8>());
                NativeValue::Promise(runtime::promise_view_map(&source, |_| {
                    NativeValue::Undefined
                }))
            }
            "releaseLock" if args.is_empty() => {
                runtime::web_reader_release(reader);
                NativeValue::Undefined
            }
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if let NativeValue::WebBytesController(stream) = &recv {
        return match method {
            "enqueue" if args.len() == 1 => {
                let bytes = native_fetch_body_bytes(args[0].clone()).unwrap_or_else(|| {
                    runtime::throw_type_error(
                        "ReadableStream byte controller requires a Uint8Array chunk".into(),
                    )
                });
                runtime::web_stream_enqueue(stream, bytes);
                NativeValue::Undefined
            }
            "close" if args.is_empty() => {
                runtime::web_stream_close(stream);
                NativeValue::Undefined
            }
            "error" => {
                let reason = args.first().cloned().unwrap_or(NativeValue::Undefined);
                runtime::web_stream_error(stream, runtime::caught_value(reason));
                NativeValue::Undefined
            }
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if let NativeValue::WebTextStream(stream) = &recv {
        return match method {
            "getReader" if args.is_empty() => {
                NativeValue::WebTextReader(runtime::web_stream_get_reader(stream))
            }
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if let NativeValue::WebTextReader(reader) = &recv {
        return match method {
            "read" if args.is_empty() => {
                let source = runtime::web_reader_read(reader);
                NativeValue::Promise(runtime::promise_view_map(
                    &source,
                    native_web_text_read_result,
                ))
            }
            "cancel" => {
                let source = runtime::web_reader_cancel(reader, runtime::string(""));
                NativeValue::Promise(runtime::promise_view_map(&source, |_| {
                    NativeValue::Undefined
                }))
            }
            "releaseLock" if args.is_empty() => {
                runtime::web_reader_release(reader);
                NativeValue::Undefined
            }
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        };
    }
    if native_value_is_function(&holder) && method == "bind" {
        return native_bind(holder, args);
    }
    if native_value_is_function(&holder) && matches!(method, "call" | "apply") {
        let receiver = args.first().cloned().unwrap_or(NativeValue::Undefined);
        let args = if method == "call" {
            args.into_iter().skip(1).collect()
        } else {
            match args.get(1) {
                None | Some(NativeValue::Null | NativeValue::Undefined) => vec![],
                Some(value) => native_value_apply_arguments(value),
            }
        };
        return native_value_call_with_this(holder, receiver, args, name);
    }
    if let NativeValue::HttpResponse(response) = recv {
        return native_fetch_response_invoke(response, method, args);
    }
    if let NativeValue::Headers(response) = recv {
        return native_headers_invoke(response, method, args);
    }
    if let NativeValue::Promise(promise) = recv {
        return NativeValue::Promise(match method {
            "then" => native_promise_then(promise, args),
            // Promise.prototype.catch(onRejected) is then(undefined, onRejected).
            "catch" => native_promise_then(
                promise,
                vec![NativeValue::Undefined, args.into_iter().next().unwrap_or(NativeValue::Undefined)],
            ),
            "finally" => native_promise_finally(promise, args),
            _ => runtime::throw_type_error(format!("{} is not a function", name)),
        });
    }
    if let NativeValue::Map(map) = recv {
        let key = args.first().cloned().unwrap_or(NativeValue::Undefined);
        match method {
            "get" => js_map_get(
                &map,
                &key,
                native_value_key_hash(&key),
                native_value_same_key,
            )
            .unwrap_or(NativeValue::Undefined),
            "has" => NativeValue::Boolean(js_map_has(
                &map,
                &key,
                native_value_key_hash(&key),
                native_value_same_key,
            )),
            "delete" => NativeValue::Boolean(js_map_delete(
                &map,
                &key,
                native_value_key_hash(&key),
                native_value_same_key,
            )),
            "set" => {
                let value = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
                let key = native_map_key(key);
                let hash = native_value_key_hash(&key);
                js_map_set(&map, key, value, hash, native_value_same_key);
                NativeValue::Map(map)
            }
            "clear" => {
                js_map_clear(&map);
                NativeValue::Undefined
            }
            _ => runtime::throw_type_error(format!(
                "scriptc: native Map method {} is not supported yet",
                method
            )),
        }
    } else {
        native_value_call_with_this(recv, holder, args, name)
    }
}
