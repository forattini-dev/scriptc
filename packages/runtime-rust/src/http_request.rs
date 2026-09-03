// IncomingMessage stream state and lifecycle. Metadata/property accessors
// remain beside the shared request handle in http.rs; delivery lives here so
// HTTP response growth cannot push either maintained file past 1200 lines.

pub fn http_request_on_data(
    request: &JsHttpRequest,
    callback: Rc<dyn Fn(JsBytes<u8>, bool)>,
    trace: NetTrace,
    once: bool,
) {
    request.with_mut(|request| {
        if !request.ended {
            request.flowing = true;
            request.data_listeners.push(HttpDataListener { invoke: callback, trace, once });
        }
    });
    http_dispatch_data(request);
    http_request_maybe_finish(request);
}

pub fn http_request_set_encoding(request: &JsHttpRequest, encoding: &JsString) {
    match encoding.as_ref() {
        "utf8" | "utf-8" => request.with_mut(|request| request.encoding_utf8 = true),
        "ascii" | "latin1" | "binary" | "base64" | "base64url" | "hex" | "ucs2"
        | "ucs-2" | "utf16le" | "utf-16le" => throw_error(format!(
            "setEncoding('{encoding}') is not supported yet (only 'utf8' here)"
        )),
        _ => throw_type_error_code(
            format!("Unknown encoding: {encoding}"),
            "ERR_UNKNOWN_ENCODING",
        ),
    }
}

pub fn http_request_pause(request: &JsHttpRequest) {
    let socket = request.with_mut(|request| {
        request.paused = true;
        request.socket.clone()
    });
    if let Some(socket) = socket {
        net_socket_pause(&socket);
    }
}

pub fn http_request_resume(request: &JsHttpRequest) {
    let socket = request.with_mut(|request| {
        request.paused = false;
        request.flowing = true;
        request.socket.clone()
    });
    if let Some(socket) = socket {
        net_socket_resume(&socket);
    }
    let request = request.clone();
    process_next_tick(Box::new(move || {
        http_dispatch_data(&request);
        http_request_maybe_finish(&request);
    }));
}

pub fn http_request_readable(request: &JsHttpRequest) -> bool {
    request.with(|request| {
        !request.ended && request.socket.as_ref().is_some_and(net_socket_readable)
    })
}

pub fn http_request_destroyed(request: &JsHttpRequest) -> bool {
    request.with(|request| request.destroyed)
}

pub fn http_request_on_aborted(
    request: &JsHttpRequest,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    _once: bool,
) {
    request.with_mut(|request| {
        if !request.aborted && !request.close_emitted {
            request.aborted_listeners.push(HttpVoidListener { invoke: callback, trace });
        }
    });
}

pub fn http_request_on_close(
    request: &JsHttpRequest,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    _once: bool,
) {
    request.with_mut(|request| {
        if !request.close_emitted {
            request.close_listeners.push(HttpVoidListener { invoke: callback, trace });
        }
    });
}

fn http_request_dispatch_aborted(request: &JsHttpRequest) {
    let listeners = request.with_mut(|request| {
        if request.ended || request.aborted || request.close_emitted {
            return Vec::new();
        }
        request.aborted = true;
        std::mem::take(&mut request.aborted_listeners)
    });
    for listener in listeners {
        (listener.invoke)();
    }
}

fn http_request_dispatch_close(request: &JsHttpRequest) {
    let listeners = request.with_mut(|request| {
        if request.close_emitted {
            return Vec::new();
        }
        request.close_emitted = true;
        request.destroyed = true;
        request.aborted_listeners.clear();
        std::mem::take(&mut request.close_listeners)
    });
    for listener in listeners {
        (listener.invoke)();
    }
}

pub fn http_request_destroy(request: &JsHttpRequest) {
    let socket = request.with_mut(|request| {
        request.destroyed = true;
        request.socket.clone()
    });
    if let Some(socket) = socket {
        net_socket_destroy(&socket);
    }
    http_request_dispatch_aborted(request);
    let request = request.clone();
    process_next_tick(Box::new(move || http_request_dispatch_close(&request)));
}

pub fn http_request_on_end(
    request: &JsHttpRequest,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    _once: bool,
) {
    request.with_mut(|request| {
        if !request.ended {
            request.end_listeners.push(HttpVoidListener { invoke: callback, trace });
        }
    });
}

pub fn http_request_pipe_response(request: &JsHttpRequest, response: &JsHttpResponse) {
    let write_response = response.clone();
    let write_trace = response.clone();
    let end_response = response.clone();
    let end_trace = response.clone();
    request.with_mut(|request| {
        if request.ended {
            return;
        }
        request.flowing = true;
        request.data_listeners.push(HttpDataListener {
            invoke: Rc::new(move |chunk, _encoding_utf8| {
                http_response_write_bytes(&write_response, &chunk)
            }),
            trace: Rc::new(move |tracer| tracer.edge(&write_trace)),
            once: false,
        });
        request.end_listeners.push(HttpVoidListener {
            invoke: Rc::new(move || http_response_end(&end_response)),
            trace: Rc::new(move |tracer| tracer.edge(&end_trace)),
        });
    });
    http_dispatch_data(request);
    http_request_maybe_finish(request);
}
