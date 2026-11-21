// Native Fetch values reuse the runtime HTTP request handle.  No JavaScript
// engine or source island participates in request or response processing.
fn native_abort_controller_new() -> NativeValue {
    let signal = runtime::abort_controller_new::<NativeValue>();
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("signal"), NativeValue::AbortSignal(signal.clone())),
            (runtime::string("abort"), NativeValue::AbortControllerAbort(signal)),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}

fn native_transform_stream_new() -> NativeValue {
    let readable = runtime::web_stream_empty(runtime::bytes_empty::<u8>());
    let writable = NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: Vec::new(),
        hash_index: NativeHashIndex::default(),
    }));
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("readable"), NativeValue::WebBytesStream(readable)),
            (runtime::string("writable"), writable),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}

fn native_abort_signal_static(method: u8, args: Vec<NativeValue>) -> NativeValue {
    match method {
        0 => {
            if args.len() != 1 {
                runtime::throw_type_error("AbortSignal.timeout requires one delay".into());
            }
            let delay = native_compare_number(&args[0]);
            NativeValue::AbortSignal(runtime::abort_signal_timeout(
                delay,
                NativeValue::String(runtime::string("TimeoutError")),
            ))
        }
        1 => {
            if args.len() != 1 {
                runtime::throw_type_error("AbortSignal.any requires one signal sequence".into());
            }
            let signals = native_value_apply_arguments(&args[0])
                .into_iter()
                .map(|value| match value {
                    NativeValue::AbortSignal(signal) => signal,
                    _ => runtime::throw_type_error(
                        "AbortSignal.any entries must be AbortSignals".into(),
                    ),
                })
                .collect();
            NativeValue::AbortSignal(runtime::abort_signal_any(signals))
        }
        2 => {
            if args.len() > 1 {
                runtime::throw_type_error("AbortSignal.abort accepts at most one reason".into());
            }
            NativeValue::AbortSignal(runtime::abort_signal_new_aborted(
                args.first().cloned().unwrap_or(NativeValue::Undefined),
            ))
        }
        _ => unreachable!("native AbortSignal static method"),
    }
}

fn native_fetch_headers(value: NativeValue) -> runtime::JsArray<runtime::JsString> {
    let mut flattened = Vec::new();
    match value {
        NativeValue::Undefined | NativeValue::Null => {}
        NativeValue::Object(object) | NativeValue::Record(_, object) => {
            object.with(|data| {
                for (name, value) in &data.entries {
                    flattened.push(name.clone());
                    flattened.push(match value.clone() {
                        NativeValue::String(value) => value,
                        value => native_value_string(value),
                    });
                }
            });
        }
        _ => runtime::throw_type_error(
            "scriptc: fetch headers require a plain string record".into(),
        ),
    }
    runtime::array_new(flattened)
}

fn native_headers_new(init: NativeValue) -> NativeValue {
    let response = runtime::fetch_response_new_empty();
    let append = |name: NativeValue, value: NativeValue| {
        let name = native_value_string(name);
        let value = native_value_string(value);
        runtime::http_request_header_append(&response, &name, &value);
    };
    match init {
        NativeValue::Undefined => {}
        NativeValue::Headers(source) => {
            for (name, value) in runtime::http_request_headers(&source) {
                runtime::http_request_header_append(&response, &name, &value);
            }
        }
        NativeValue::Object(object) | NativeValue::Record(_, object) => {
            let entries = object.with(|data| data.entries.clone());
            for (name, value) in entries {
                append(NativeValue::String(name), value);
            }
        }
        sequence if native_value_is_array(&sequence) => {
            for pair in native_value_apply_arguments(&sequence) {
                if !native_value_is_array(&pair) {
                    runtime::throw_type_error("Headers sequence entries must be pairs".into());
                }
                let values = native_value_apply_arguments(&pair);
                if values.len() != 2 {
                    runtime::throw_type_error("Headers sequence entries must contain exactly two items".into());
                }
                append(values[0].clone(), values[1].clone());
            }
        }
        _ => runtime::throw_type_error(
            "Headers initializer must be a Headers object, string record, or sequence of pairs".into(),
        ),
    }
    NativeValue::Headers(response)
}

fn native_response_new(body: NativeValue, init: NativeValue) -> NativeValue {
    let response = match body {
        NativeValue::Undefined | NativeValue::Null => runtime::fetch_response_new_empty(),
        NativeValue::String(body) => runtime::fetch_response_new_text(&body),
        NativeValue::ArrayBuffer(body) => runtime::fetch_response_new_bytes(&body),
        NativeValue::WebBytesStream(stream) => {
            runtime::fetch_response_new_stream(&stream, |bytes| bytes)
        }
        _ => runtime::throw_type_error(
            "Response body must be null, a string, an ArrayBuffer, or a native ReadableStream of bytes".into(),
        ),
    };
    let read = |name: &str| match &init {
        NativeValue::Undefined | NativeValue::Null => NativeValue::Undefined,
        NativeValue::Object(_) | NativeValue::Record(..) => {
            native_value_get(init.clone(), runtime::string(name))
        }
        _ => runtime::throw_type_error("Response init must be an object".into()),
    };
    let status = match read("status") {
        NativeValue::Undefined => 200.0,
        value => native_compare_number(&value),
    };
    if status.fract() != 0.0 || !(200.0..=599.0).contains(&status) {
        runtime::throw_range_error(format!(
            "init[\"status\"] must be in the range of 200 to 599, inclusive: {status}"
        ));
    }
    let status_text = match read("statusText") {
        NativeValue::Undefined => runtime::empty_string(),
        value => native_value_string(value),
    };
    let headers = native_fetch_headers(read("headers"));
    runtime::fetch_response_apply_init(&response, status, &status_text, &headers);
    NativeValue::HttpResponse(response)
}

fn native_fetch_call(args: Vec<NativeValue>) -> NativeValue {
    if args.is_empty() || args.len() > 2 {
        runtime::throw_type_error("fetch requires one input and an optional init".into());
    }
    let input = args[0].clone();
    let url = match input {
        NativeValue::String(url) => url,
        NativeValue::Url(url) => runtime::url_href(&url),
        NativeValue::Object(_) | NativeValue::Record(..) => {
            match native_value_get(input, runtime::string("url")) {
                NativeValue::String(url) => url,
                _ => runtime::throw_type_error("fetch Request.url must be a string".into()),
            }
        }
        _ => runtime::throw_type_error("fetch input must be a URL string, URL, or Request".into()),
    };
    let init = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
    let read = |name: &str| match &init {
        NativeValue::Undefined | NativeValue::Null => NativeValue::Undefined,
        NativeValue::Object(_) | NativeValue::Record(..) => {
            native_value_get(init.clone(), runtime::string(name))
        }
        _ => runtime::throw_type_error("fetch init must be an object".into()),
    };
    let method = match read("method") {
        NativeValue::Undefined => runtime::string("GET"),
        NativeValue::String(method) => method,
        value => native_value_string(value),
    };
    let headers = native_fetch_headers(read("headers"));
    let body = match read("body") {
        NativeValue::Undefined | NativeValue::Null => None,
        NativeValue::String(body) => Some(runtime::buffer_from_string(
            &body,
            &runtime::string("utf8"),
        )),
        body => native_fetch_body_bytes(body).or_else(|| {
            runtime::throw_type_error(
                "scriptc: fetch body currently requires string, ArrayBuffer or Uint8Array".into(),
            )
        }),
    };
    let source = runtime::fetch_start(&url, &method, &headers, body.as_ref());
    let target = runtime::promise_new();
    let result = target.clone();
    runtime::promise_then(
        &source,
        Box::new(move |outcome| match outcome {
            Ok(response) => {
                let _ = runtime::promise_fulfill(&target, NativeValue::HttpResponse(response));
            }
            Err(reason) => {
                let _ = runtime::promise_reject(&target, reason);
            }
        }),
    );
    NativeValue::Promise(result)
}

fn native_fetch_response_get(
    response: runtime::JsHttpRequest,
    key: &runtime::JsString,
) -> NativeValue {
    match key.well_formed_utf8().unwrap_or("") {
        "status" => NativeValue::Number(runtime::http_request_status_code(&response).unwrap_or(0.0)),
        "statusText" => NativeValue::String(
            runtime::http_request_status_message(&response).unwrap_or_else(runtime::empty_string),
        ),
        "url" => NativeValue::String(runtime::http_request_url(&response)),
        "ok" => {
            let status = runtime::http_request_status_code(&response).unwrap_or(0.0);
            NativeValue::Boolean((200.0..300.0).contains(&status))
        }
        "bodyUsed" => NativeValue::Boolean(runtime::http_request_fetch_body_used(&response)),
        "headers" => NativeValue::Headers(response),
        "body" => runtime::fetch_response_body_stream(&response)
            .map(NativeValue::WebBytesStream)
            .unwrap_or(NativeValue::Null),
        _ => native_value_missing_kind(key, "Response"),
    }
}

fn native_fetch_response_invoke(
    response: runtime::JsHttpRequest,
    method: &str,
    args: Vec<NativeValue>,
) -> NativeValue {
    if !args.is_empty() {
        runtime::throw_type_error(format!("Response.{method} does not accept arguments"));
    }
    let target = runtime::promise_new();
    let result = target.clone();
    match method {
        "text" => {
            let source = runtime::fetch_response_text(&response);
            runtime::promise_then(&source, Box::new(move |outcome| match outcome {
                Ok(value) => { let _ = runtime::promise_fulfill(&target, NativeValue::String(value)); }
                Err(reason) => { let _ = runtime::promise_reject(&target, reason); }
            }));
        }
        "arrayBuffer" => {
            let source = runtime::fetch_response_bytes(&response);
            runtime::promise_then(&source, Box::new(move |outcome| match outcome {
                Ok(value) => { let _ = runtime::promise_fulfill(&target, NativeValue::ArrayBuffer(value)); }
                Err(reason) => { let _ = runtime::promise_reject(&target, reason); }
            }));
        }
        _ => runtime::throw_type_error(format!("Response.{method} is not supported")),
    }
    NativeValue::Promise(result)
}

fn native_headers_get(response: runtime::JsHttpRequest, key: &runtime::JsString) -> NativeValue {
    let headers = runtime::http_request_headers(&response);
    if key == "length" {
        return NativeValue::Number(headers.len() as f64);
    }
    if let Ok(index) = key.parse::<usize>()
        && key == index.to_string()
    {
        return headers.get(index).map(|(name, value)| {
            NativeValue::Array(runtime::array_new(vec![
                NativeValue::String(name.clone()),
                NativeValue::String(value.clone()),
            ]))
        }).unwrap_or(NativeValue::Undefined);
    }
    native_value_missing_kind(key, "Headers")
}

fn native_headers_invoke(
    response: runtime::JsHttpRequest,
    method: &str,
    args: Vec<NativeValue>,
) -> NativeValue {
    let string = |index: usize| {
        args.get(index)
            .cloned()
            .map(native_value_string)
            .unwrap_or_else(|| runtime::string("undefined"))
    };
    match (method, args.len()) {
        ("get", 1) => runtime::fetch_response_header(&response, &string(0))
            .map(NativeValue::String)
            .unwrap_or(NativeValue::Null),
        ("has", 1) => NativeValue::Boolean(runtime::http_request_header_has(
            &response,
            &string(0),
        )),
        ("append", 2) => {
            runtime::http_request_header_append(&response, &string(0), &string(1));
            NativeValue::Undefined
        }
        ("set", 2) => {
            runtime::http_request_header_set(&response, &string(0), &string(1));
            NativeValue::Undefined
        }
        ("delete", 1) => {
            runtime::http_request_header_delete(&response, &string(0));
            NativeValue::Undefined
        }
        ("forEach", 1 | 2) => {
            let callback = args[0].clone();
            if !native_value_is_function(&callback) {
                runtime::throw_type_error("Headers.forEach callback is not a function".into());
            }
            let this_arg = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            let mut headers = runtime::http_request_headers(&response);
            headers.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (key, value) in headers {
                native_value_call_with_this(
                    callback.clone(),
                    this_arg.clone(),
                    vec![
                        NativeValue::String(value),
                        NativeValue::String(key),
                        NativeValue::Headers(response.clone()),
                    ],
                    "Headers.forEach callback",
                );
            }
            NativeValue::Undefined
        }
        _ => runtime::throw_type_error(format!("Headers.{method} is not supported")),
    }
}
