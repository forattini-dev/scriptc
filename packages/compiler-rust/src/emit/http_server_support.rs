// Node `http` server values reached through erased JavaScript (for example
// `ws`'s WebSocketServer or an HTTP framework): the native net.Server owns
// listening, and the HTTP runtime delivers request/response handles.
fn native_http_server_value(server: runtime::JsNetServer) -> NativeValue {
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("on"), NativeValue::NetServerMethod(server.clone(), 0)),
            (runtime::string("addListener"), NativeValue::NetServerMethod(server.clone(), 0)),
            (runtime::string("once"), NativeValue::NetServerMethod(server.clone(), 1)),
            (runtime::string("off"), NativeValue::NetServerMethod(server.clone(), 2)),
            (runtime::string("removeListener"), NativeValue::NetServerMethod(server.clone(), 2)),
            (runtime::string("listen"), NativeValue::NetServerMethod(server.clone(), 6)),
            (runtime::string("close"), NativeValue::NetServerMethod(server.clone(), 4)),
            (runtime::string("address"), NativeValue::NetServerMethod(server, 5)),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}

/// `server.listen([port][, host][, backlog][, callback])` on a TCP port.
fn native_http_server_listen(server: &runtime::JsNetServer, args: &[NativeValue]) {
    let callback = args.iter().rev().find(|value| native_value_is_function(value)).cloned();
    let port = match args.first() {
        Some(NativeValue::Number(port)) => *port,
        _ => 0.0,
    };
    let host = args.iter().skip(1).find_map(|value| match value {
        NativeValue::String(host) => Some(host.clone()),
        _ => None,
    });
    if let Some(callback) = callback {
        native_net_server_listener(server, &runtime::string("listening"), callback, true);
    }
    match host {
        Some(host) => runtime::net_server_listen_options(server, port, &host, false),
        None => runtime::net_server_listen(server, port),
    }
}

/// `server.address()`: `{ address, family, port }` of the bound socket.
fn native_http_server_address(server: &runtime::JsNetServer) -> NativeValue {
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("address"), NativeValue::String(runtime::net_server_address_ip(server))),
            (runtime::string("family"), NativeValue::String(runtime::net_server_address_family(server))),
            (runtime::string("port"), NativeValue::Number(runtime::net_server_address_port(server))),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}

fn native_http_server_on_request(
    server: &runtime::JsNetServer,
    callback: NativeValue,
    trace: std::rc::Rc<dyn for<'a> Fn(&mut runtime::Tracer<'a>)>,
    once: bool,
) {
    let target = callback;
    runtime::http_server_on_request(
        server,
        std::rc::Rc::new(move |request, response| {
            let _ = native_value_call(
                target.clone(),
                vec![native_http_incoming_value(request), native_http_response_value(response)],
                "http.Server request listener",
            );
        }),
        trace,
        once,
    );
}

/// The request as an ordinary object: `method`, `url`, lower-cased
/// `headers` and `httpVersion` (request body streaming is not exposed here).
fn native_http_incoming_value(request: runtime::JsHttpRequest) -> NativeValue {
    let headers = runtime::http_request_headers(&request)
        .into_iter()
        .map(|(name, value)| (name, NativeValue::String(value)))
        .collect::<Vec<_>>();
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("method"), NativeValue::String(runtime::http_request_method(&request))),
            (runtime::string("url"), NativeValue::String(runtime::http_request_url(&request))),
            (
                runtime::string("headers"),
                NativeValue::Object(runtime::Gc::new(NativeMap {
                    null_prototype: false,
                    symbol_properties: None,
                    entries: headers,
                    hash_index: NativeHashIndex::default(),
                })),
            ),
            (
                runtime::string("httpVersion"),
                NativeValue::String(runtime::http_request_http_version(&request)),
            ),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}

fn native_http_response_value(response: runtime::JsHttpResponse) -> NativeValue {
    let method = |index: u8| NativeValue::HttpServerResponseMethod(response.clone(), index);
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("writeHead"), method(0)),
            (runtime::string("setHeader"), method(1)),
            (runtime::string("getHeader"), method(2)),
            (runtime::string("write"), method(3)),
            (runtime::string("end"), method(4)),
            (runtime::string("removeHeader"), method(5)),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}

fn native_http_header_value(value: NativeValue) -> runtime::JsString {
    match value {
        NativeValue::String(value) => value,
        NativeValue::Array(values) => {
            let parts = runtime::array_values(&values)
                .into_iter()
                .map(|value| native_value_string(value).to_utf8_lossy().to_owned())
                .collect::<Vec<_>>();
            runtime::string(&parts.join(", "))
        }
        other => native_value_string(other),
    }
}

fn native_http_response_call(
    response: runtime::JsHttpResponse,
    method: u8,
    receiver: NativeValue,
    args: Vec<NativeValue>,
) -> NativeValue {
    let text = |index: usize| args.get(index).cloned().map(native_value_string);
    match method {
        0 => {
            let status = match args.first() {
                Some(NativeValue::Number(status)) => *status,
                _ => runtime::throw_type_error("The \"statusCode\" argument must be of type number".into()),
            };
            let headers = args.iter().skip(1).find(|value| {
                matches!(value, NativeValue::Object(_) | NativeValue::Record(..))
            });
            if let Some(headers) = headers {
                let keys = native_reflect_own_keys(headers.clone());
                for index in 0..runtime::array_len(&keys) as usize {
                    if let NativeValue::String(name) = runtime::array_get(&keys, index as f64) {
                        let value = native_value_get(headers.clone(), name.clone());
                        runtime::http_response_set_header(&response, &name, &native_http_header_value(value));
                    }
                }
            }
            runtime::http_response_write_head(&response, status);
            receiver
        }
        1 => {
            let name = text(0).unwrap_or_else(|| runtime::string("undefined"));
            let value = native_http_header_value(args.get(1).cloned().unwrap_or(NativeValue::Undefined));
            runtime::http_response_set_header(&response, &name, &value);
            receiver
        }
        2 => {
            let name = text(0).unwrap_or_else(|| runtime::string("undefined"));
            runtime::http_response_get_header(&response, &name)
                .map(NativeValue::String)
                .unwrap_or(NativeValue::Undefined)
        }
        3 => {
            match args.first().cloned().unwrap_or(NativeValue::Undefined) {
                NativeValue::String(chunk) => runtime::http_response_write_str(&response, &chunk),
                chunk => match native_file_handle_bytes(chunk) {
                    Some(bytes) => runtime::http_response_write_bytes(&response, &bytes),
                    None => runtime::throw_type_error(
                        "The \"chunk\" argument must be of type string or an instance of Buffer".into(),
                    ),
                },
            }
            NativeValue::Boolean(true)
        }
        4 => {
            match args.first().cloned() {
                Some(NativeValue::String(chunk)) => runtime::http_response_end_str(&response, &chunk),
                Some(chunk) if !native_value_is_function(&chunk) && !matches!(chunk, NativeValue::Undefined | NativeValue::Null) => {
                    match native_file_handle_bytes(chunk) {
                        Some(bytes) => runtime::http_response_end_bytes(&response, &bytes),
                        None => runtime::throw_type_error(
                            "The \"chunk\" argument must be of type string or an instance of Buffer".into(),
                        ),
                    }
                }
                _ => runtime::http_response_end(&response),
            }
            receiver
        }
        _ => {
            let name = text(0).unwrap_or_else(|| runtime::string("undefined"));
            runtime::http_response_remove_header(&response, &name);
            NativeValue::Undefined
        }
    }
}
