struct HttpClientConnection {
    buffer: Vec<u8>,
    response: Option<JsHttpRequest>,
    body_remaining: Option<usize>,
    chunked: bool,
    chunk_remaining: Option<usize>,
}

impl HttpClientConnection {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(response) = &self.response {
            tracer.edge(response);
        }
    }
}

type HttpClientResponseCallback = (Rc<dyn Fn(JsHttpRequest)>, NetTrace);

type ParsedHttpResponse = (
    f64,
    JsString,
    Vec<(JsString, JsString, JsString)>,
    Option<usize>,
    bool,
);

fn http_parse_response_head(bytes: &[u8]) -> Option<ParsedHttpResponse> {
    // HTTP/1 field values are a byte-oriented surface. Node exposes each
    // octet through its matching U+0000..U+00FF code point, so requiring a
    // UTF-8-valid whole head incorrectly rejects ordinary obs-text such as
    // a raw E9 in a response header.
    let text: String = bytes.iter().copied().map(char::from).collect();
    let mut lines = text[..text.len().saturating_sub(4)].split("\r\n");
    let status_line = lines.next()?;
    let mut parts = status_line.splitn(3, ' ');
    if !matches!(parts.next()?, "HTTP/1.0" | "HTTP/1.1") {
        return None;
    }
    let status: u16 = parts.next()?.parse().ok()?;
    let status_message = string(parts.next().unwrap_or(""));
    let mut headers = Vec::new();
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let (raw_name, raw_value) = line.split_once(':')?;
        let name = raw_name.trim();
        let value = raw_value.trim();
        let lower = name.to_ascii_lowercase();
        if lower == "content-length" {
            content_length = Some(value.parse().ok()?);
        } else if lower == "transfer-encoding" {
            chunked = value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("chunked"));
        }
        headers.push((string(name), string(&lower), string(value)));
    }
    Some((f64::from(status), status_message, headers, content_length, chunked))
}

fn http_client_dispatch_response(request: &JsHttpClientRequest, response: &JsHttpRequest) {
    let listeners = request.with_mut(|request| {
        let listeners = request.response_listeners.clone();
        request.response_listeners.retain(|listener| !listener.once);
        listeners
    });
    for listener in listeners {
        (listener.invoke)(response.clone());
    }
}

fn http_client_dispatch_error(request: &JsHttpClientRequest, error: JsError) {
    let listeners = request.with_mut(|request| {
        let listeners = request.error_listeners.clone();
        request.error_listeners.retain(|listener| !listener.once);
        listeners
    });
    if listeners.is_empty() {
        throw_value(error);
    }
    for listener in listeners {
        (listener.invoke)(error.clone());
    }
}

fn http_client_dispatch_close(request: &JsHttpClientRequest) {
    let (listeners, agent) = request.with_mut(|request| {
        request.destroyed = true;
        (
            std::mem::take(&mut request.close_listeners),
            request.agent.take(),
        )
    });
    if let Some(agent) = agent {
        http_agent_client_done(&agent, request);
    }
    for listener in listeners {
        (listener.invoke)();
    }
}

/// Drains buffered response bytes into the response stream. Returns false
/// when the framing is unrecoverable, which the caller reports as a parse
/// error rather than stalling the connection.
fn http_client_drain(connection: &Rc<RefCell<HttpClientConnection>>) -> bool {
    loop {
        let next = {
            let mut connection = connection.borrow_mut();
            let Some(response) = connection.response.clone() else {
                return true;
            };
            if connection.chunked {
                let state = &mut *connection;
                match http_chunked_step(
                    &mut state.buffer,
                    &mut state.chunk_remaining,
                    HTTP_MAX_CHUNK_LINE,
                ) {
                    HttpChunkStep::NeedMore => return true,
                    HttpChunkStep::Data(body) => Some((response, body, false)),
                    HttpChunkStep::Done => Some((response, Vec::new(), true)),
                    HttpChunkStep::Bad => {
                        connection.buffer.clear();
                        connection.response = None;
                        return false;
                    }
                }
            } else if let Some(remaining) = connection.body_remaining {
                if remaining == 0 {
                    Some((response, Vec::new(), true))
                } else if connection.buffer.is_empty() {
                    return true;
                } else {
                    let take = remaining.min(connection.buffer.len());
                    let body = connection.buffer.drain(..take).collect();
                    connection.body_remaining = Some(remaining - take);
                    Some((response, body, remaining == take))
                }
            } else if connection.buffer.is_empty() {
                return true;
            } else {
                let body = std::mem::take(&mut connection.buffer);
                Some((response, body, false))
            }
        };
        let Some((response, body, finish)) = next else {
            continue;
        };
        if !body.is_empty() {
            http_request_push(&response, &body);
        }
        if finish {
            http_request_finish(&response);
            if let Some(socket) = response.with(|response| response.socket.clone()) {
                net_socket_destroy(&socket);
            }
            return true;
        }
    }
}

fn http_client_feed(
    connection: &Rc<RefCell<HttpClientConnection>>,
    request: &JsHttpClientRequest,
    bytes: &[u8],
) {
    let created = {
        let mut connection = connection.borrow_mut();
        connection.buffer.extend_from_slice(bytes);
        if connection.response.is_some() {
            None
        } else {
            let Some(head_len) = http_header_end(&connection.buffer) else {
                return;
            };
            let Some((status, status_message, headers, content_length, chunked)) =
                http_parse_response_head(&connection.buffer[..head_len])
            else {
                let socket = request.with(|request| request.socket.clone());
                if let Some(socket) = socket {
                    net_socket_destroy(&socket);
                }
                http_client_dispatch_error(
                    request,
                    error_new("Error", string("Parse Error")),
                );
                return;
            };
            connection.buffer.drain(..head_len);
            connection.body_remaining = content_length;
            connection.chunked = chunked;
            let socket = request.with(|request| request.socket.clone());
            let response = Gc::new(HttpRequestData {
                fetch_response: false,
                socket,
                method: empty_string(),
                url: empty_string(),
                status_code: Some(status),
                status_message: Some(status_message),
                headers,
                body: Vec::new(),
                ended: false,
                finish_pending: false,
                paused: false,
                flowing: false,
                data_listeners: Vec::new(),
                end_listeners: Vec::new(),
            });
            connection.response = Some(response.clone());
            Some((request.clone(), response))
        }
    };
    if let Some((request, response)) = created {
        http_client_dispatch_response(&request, &response);
    }
    if !http_client_drain(connection) {
        let socket = request.with(|request| request.socket.clone());
        if let Some(socket) = socket {
            net_socket_destroy(&socket);
        }
        http_client_dispatch_error(request, error_new("Error", string("Parse Error")));
    }
}

fn http_client_eof(connection: &Rc<RefCell<HttpClientConnection>>) {
    http_client_drain(connection);
    let response = connection.borrow().response.clone();
    if let Some(response) = response {
        http_request_finish(&response);
    }
}

fn http_client_headers(values: &JsArray<JsString>) -> Vec<(JsString, JsString)> {
    let length = array_len(values) as usize;
    let mut headers = Vec::with_capacity(length / 2);
    for index in (0..length.saturating_sub(1)).step_by(2) {
        headers.push((
            array_get(values, index as f64),
            array_get(values, (index + 1) as f64),
        ));
    }
    headers
}

#[allow(clippy::too_many_arguments)]
fn http_client_new_with_socket(
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    secure: bool,
    timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
    reject_unauthorized: bool,
    ca: &JsString,
    socket: Option<JsNetSocket>,
    callback: Option<HttpClientResponseCallback>,
) -> JsHttpClientRequest {
    let port_number = net_port(port);
    let request = Gc::new(HttpClientRequestData {
        socket: socket.clone(),
        connection: None,
        agent: None,
        host: host.clone(),
        port: port_number,
        path: path.clone(),
        method: method.clone(),
        secure,
        timeout,
        reject_unauthorized,
        ca: ca.clone(),
        headers: http_client_headers(headers),
        body: Vec::new(),
        half_close_after_write: true,
        sent: false,
        destroyed: false,
        response_listeners: Vec::new(),
        error_listeners: Vec::new(),
        close_listeners: Vec::new(),
    });
    if let Some((invoke, trace)) = callback {
        request.with_mut(|request| {
            request.response_listeners.push(HttpResponseListener { invoke, trace, once: true });
        });
    }
    let connection = Rc::new(RefCell::new(HttpClientConnection {
        buffer: Vec::new(),
        response: None,
        body_remaining: None,
        chunked: false,
        chunk_remaining: None,
    }));
    request.with_mut(|request| request.connection = Some(connection.clone()));
    if let Some(socket) = socket {
        let error_request = request.clone();
        let error_trace = request.clone();
        net_socket_on_error(
            &socket,
            Rc::new(move |error| http_client_dispatch_error(&error_request, error)),
            Rc::new(move |tracer| tracer.edge(&error_trace)),
            false,
        );
        let close_request = request.clone();
        let close_trace = request.clone();
        net_socket_on_close(
            &socket,
            Rc::new(move || http_client_dispatch_close(&close_request)),
            Rc::new(move |tracer| tracer.edge(&close_trace)),
            true,
        );
        let data_connection = connection.clone();
        let data_request = request.clone();
        let data_trace = connection.clone();
        net_socket_on_data(
            &socket,
            Rc::new(move |chunk, _encoding_utf8| {
                http_client_feed(&data_connection, &data_request, &bytes_u8_values(&chunk));
            }),
            Rc::new(move |tracer| data_trace.borrow().trace(tracer)),
            false,
        );
        let end_connection = connection.clone();
        let end_trace = connection;
        net_socket_on_end(
            &socket,
            Rc::new(move || http_client_eof(&end_connection)),
            Rc::new(move |tracer| end_trace.borrow().trace(tracer)),
            true,
        );
    }
    if auto_end {
        http_client_end(&request);
    }
    request
}

#[allow(clippy::too_many_arguments)]
fn http_client_new(
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    secure: bool,
    timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
    reject_unauthorized: bool,
    ca: &JsString,
    callback: Option<HttpClientResponseCallback>,
) -> JsHttpClientRequest {
    let socket = (!secure).then(|| net_socket_connect(port, host));
    http_client_new_with_socket(
        host, port, path, method, secure, timeout, headers, auto_end, reject_unauthorized, ca,
        socket, callback,
    )
}

pub fn http_client_request(
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    _timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
) -> JsHttpClientRequest {
    http_client_new(
        host, port, path, method, false, _timeout, headers, auto_end, true, &empty_string(), None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn http_client_request_callback(
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    _timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
    callback: Rc<dyn Fn(JsHttpRequest)>,
    trace: NetTrace,
) -> JsHttpClientRequest {
    http_client_new(
        host, port, path, method, false, _timeout, headers, auto_end, true, &empty_string(),
        Some((callback, trace)),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn https_client_request(
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    _timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
    reject_unauthorized: bool,
    ca: &JsString,
) -> JsHttpClientRequest {
    http_client_new(
        host, port, path, method, true, _timeout, headers, auto_end, reject_unauthorized, ca, None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn https_client_request_callback(
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    _timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
    reject_unauthorized: bool,
    ca: &JsString,
    callback: Rc<dyn Fn(JsHttpRequest)>,
    trace: NetTrace,
) -> JsHttpClientRequest {
    http_client_new(
        host, port, path, method, true, _timeout, headers, auto_end, reject_unauthorized, ca,
        Some((callback, trace)),
    )
}

fn http_client_url_parts(input: &JsString, secure: bool) -> (JsString, f64, JsString) {
    let url = url_new(input);
    let protocol = url_protocol(&url);
    let expected = if secure { "https:" } else { "http:" };
    if protocol.as_ref() != expected {
        throw_type_error(format!(
            "Protocol \"{protocol}\" not supported. Expected \"{expected}\""
        ));
    }
    let host = url_hostname(&url);
    let port = url_port_or(&url, if secure { 443.0 } else { 80.0 });
    let path = string(&format!("{}{}", url_pathname(&url), url_search(&url)));
    (host, port, path)
}

pub fn http_client_request_url(
    input: &JsString,
    method: &JsString,
    auto_end: bool,
) -> JsHttpClientRequest {
    let (host, port, path) = http_client_url_parts(input, false);
    http_client_new(
        &host,
        port,
        &path,
        method,
        false,
        0.0,
        &array_new(Vec::new()),
        auto_end,
        true,
        &empty_string(),
        None,
    )
}

pub fn http_client_request_url_callback(
    input: &JsString,
    method: &JsString,
    auto_end: bool,
    callback: Rc<dyn Fn(JsHttpRequest)>,
    trace: NetTrace,
) -> JsHttpClientRequest {
    let (host, port, path) = http_client_url_parts(input, false);
    http_client_new(
        &host,
        port,
        &path,
        method,
        false,
        0.0,
        &array_new(Vec::new()),
        auto_end,
        true,
        &empty_string(),
        Some((callback, trace)),
    )
}

pub fn https_client_request_url(
    input: &JsString,
    method: &JsString,
    auto_end: bool,
) -> JsHttpClientRequest {
    let (host, port, path) = http_client_url_parts(input, true);
    http_client_new(
        &host,
        port,
        &path,
        method,
        true,
        0.0,
        &array_new(Vec::new()),
        auto_end,
        true,
        &empty_string(),
        None,
    )
}

pub fn https_client_request_url_callback(
    input: &JsString,
    method: &JsString,
    auto_end: bool,
    callback: Rc<dyn Fn(JsHttpRequest)>,
    trace: NetTrace,
) -> JsHttpClientRequest {
    let (host, port, path) = http_client_url_parts(input, true);
    http_client_new(
        &host,
        port,
        &path,
        method,
        true,
        0.0,
        &array_new(Vec::new()),
        auto_end,
        true,
        &empty_string(),
        Some((callback, trace)),
    )
}

pub fn http_client_on_response(
    request: &JsHttpClientRequest,
    callback: Rc<dyn Fn(JsHttpRequest)>,
    trace: NetTrace,
    once: bool,
) {
    request.with_mut(|request| {
        request.response_listeners.push(HttpResponseListener { invoke: callback, trace, once });
    });
}

pub fn http_client_on_error(
    request: &JsHttpClientRequest,
    callback: Rc<dyn Fn(JsError)>,
    trace: NetTrace,
    once: bool,
) {
    request.with_mut(|request| {
        request.error_listeners.push(HttpErrorListener { invoke: callback, trace, once });
    });
}

pub fn http_client_on_close(
    request: &JsHttpClientRequest,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    _once: bool,
) {
    request.with_mut(|request| {
        if !request.destroyed {
            request.close_listeners.push(HttpVoidListener { invoke: callback, trace });
        }
    });
}

pub fn http_client_write_str(request: &JsHttpClientRequest, value: &JsString) {
    request.with_mut(|request| {
        if !request.sent && !request.destroyed {
            request.body.extend_from_slice(value.as_bytes());
        }
    });
}

pub fn http_client_write_bytes(request: &JsHttpClientRequest, value: &JsBytes<u8>) {
    request.with_mut(|request| {
        if !request.sent && !request.destroyed {
            request.body.extend(bytes_u8_values(value));
        }
    });
}

fn http_client_serialize(request: &mut HttpClientRequestData) -> Vec<u8> {
    let mut head = format!("{} {} HTTP/1.1\r\n", request.method, request.path);
    if http_header_index(&request.headers, "host").is_none() {
        let default_port = if request.secure { 443 } else { 80 };
        if request.port == default_port {
            head.push_str(&format!("Host: {}\r\n", request.host));
        } else {
            head.push_str(&format!("Host: {}:{}\r\n", request.host, request.port));
        }
    }
    for (name, value) in &request.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    if http_header_index(&request.headers, "connection").is_none() {
        head.push_str("Connection: keep-alive\r\n");
    }
    let chunked = http_header_index(&request.headers, "transfer-encoding")
        .is_some_and(|index| http_token_present(&request.headers[index].1, "chunked"));
    if !chunked &&
        !request.body.is_empty() &&
        http_header_index(&request.headers, "content-length").is_none()
    {
        head.push_str(&format!("Content-Length: {}\r\n", request.body.len()));
    }
    head.push_str("\r\n");
    let mut output = head.into_bytes();
    if chunked {
        output.extend(http_chunk(&request.body));
        output.extend_from_slice(b"0\r\n\r\n");
        request.body.clear();
    } else {
        output.append(&mut request.body);
    }
    output
}

pub fn http_client_end(request: &JsHttpClientRequest) {
    let dispatch = request.with_mut(|request_data| {
        if request_data.sent || request_data.destroyed {
            return None;
        }
        request_data.sent = true;
        let output = http_client_serialize(request_data);
        let half_close = request_data.half_close_after_write;
        if request_data.secure {
            let connection = request_data.connection.clone()?;
            Some((None, Some(connection), output, half_close))
        } else {
            Some((request_data.socket.clone(), None, output, half_close))
        }
    });
    let Some((socket, connection, output, half_close)) = dispatch else {
        return;
    };
    if let Some(socket) = socket {
        net_socket_queue(&socket, output);
        if half_close {
            net_socket_end(&socket);
        }
    } else if let Some(connection) = connection {
        http_tls_start(request, connection, output);
    }
}

pub fn http_client_end_str(request: &JsHttpClientRequest, value: &JsString) {
    http_client_write_str(request, value);
    http_client_end(request);
}

pub fn http_client_end_bytes(request: &JsHttpClientRequest, value: &JsBytes<u8>) {
    http_client_write_bytes(request, value);
    http_client_end(request);
}

pub fn http_client_destroy(request: &JsHttpClientRequest) {
    let (socket, secure, already_destroyed) = request.with_mut(|request| {
        let already_destroyed = request.destroyed;
        request.destroyed = true;
        (request.socket.clone(), request.secure, already_destroyed)
    });
    if let Some(socket) = socket {
        net_socket_destroy(&socket);
    } else if secure && !already_destroyed {
        http_tls_cancel(request);
        http_client_dispatch_close(request);
    }
}

pub fn http_client_destroyed(request: &JsHttpClientRequest) -> bool {
    request.with(|request| request.destroyed)
}
