#[derive(Clone)]
pub enum JsHttpTimeout {
    Undefined,
    Number(f64),
    String(JsString),
}

#[derive(Clone)]
struct HttpRequestListener {
    invoke: Rc<dyn Fn(JsHttpRequest, JsHttpResponse)>,
    trace: NetTrace,
    once: bool,
}

#[derive(Clone)]
struct HttpDataListener {
    invoke: Rc<dyn Fn(JsBytes<u8>)>,
    trace: NetTrace,
    once: bool,
}

#[derive(Clone)]
struct HttpVoidListener {
    invoke: Rc<dyn Fn()>,
    trace: NetTrace,
}

#[derive(Clone)]
struct HttpResponseListener {
    invoke: Rc<dyn Fn(JsHttpRequest)>,
    trace: NetTrace,
    once: bool,
}

#[derive(Clone)]
struct HttpErrorListener {
    invoke: Rc<dyn Fn(JsError)>,
    trace: NetTrace,
    once: bool,
}

pub struct HttpServerState {
    timeouts: [JsHttpTimeout; 5],
    join_duplicate_headers: bool,
    max_header_size: usize,
    request_listeners: Vec<HttpRequestListener>,
}

impl HttpServerState {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for listener in &self.request_listeners {
            (listener.trace)(tracer);
        }
    }
}

pub struct HttpRequestData {
    socket: Option<JsNetSocket>,
    method: JsString,
    url: JsString,
    status_code: Option<f64>,
    status_message: Option<JsString>,
    headers: Vec<(JsString, JsString, JsString)>,
    body: Vec<u8>,
    ended: bool,
    finish_pending: bool,
    paused: bool,
    flowing: bool,
    data_listeners: Vec<HttpDataListener>,
    end_listeners: Vec<HttpVoidListener>,
}

impl Trace for HttpRequestData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(socket) = &self.socket {
            tracer.edge(socket);
        }
        for listener in &self.data_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.end_listeners {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for HttpRequestData {
    fn clear_edges(&mut self) {
        self.socket = None;
        self.headers.clear();
        self.body.clear();
        self.ended = true;
        self.finish_pending = false;
        self.paused = false;
        self.flowing = false;
        self.data_listeners.clear();
        self.end_listeners.clear();
    }
}

pub type JsHttpRequest = Gc<HttpRequestData>;

pub struct HttpResponseData {
    socket: Option<JsNetSocket>,
    request: Option<JsHttpRequest>,
    status_code: f64,
    status_message: JsString,
    headers: Vec<(JsString, JsString)>,
    headers_sent: bool,
    chunked: bool,
    ended: bool,
    corked: usize,
    cork_buffer: Vec<u8>,
    cork_callbacks: Vec<HttpVoidListener>,
    finish_listeners: Vec<HttpVoidListener>,
    close_listeners: Vec<HttpVoidListener>,
    destroyed: bool,
}

impl Trace for HttpResponseData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(socket) = &self.socket {
            tracer.edge(socket);
        }
        if let Some(request) = &self.request {
            tracer.edge(request);
        }
        for listener in self
            .cork_callbacks
            .iter()
            .chain(self.finish_listeners.iter())
            .chain(self.close_listeners.iter())
        {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for HttpResponseData {
    fn clear_edges(&mut self) {
        self.socket = None;
        self.request = None;
        self.headers.clear();
        self.headers_sent = true;
        self.ended = true;
        self.cork_buffer.clear();
        self.cork_callbacks.clear();
        self.finish_listeners.clear();
        self.close_listeners.clear();
        self.destroyed = true;
    }
}

pub type JsHttpResponse = Gc<HttpResponseData>;

pub struct HttpClientRequestData {
    socket: Option<JsNetSocket>,
    connection: Option<Rc<RefCell<HttpClientConnection>>>,
    agent: Option<JsHttpAgent>,
    host: JsString,
    port: u16,
    path: JsString,
    method: JsString,
    secure: bool,
    timeout: f64,
    reject_unauthorized: bool,
    ca: JsString,
    headers: Vec<(JsString, JsString)>,
    body: Vec<u8>,
    sent: bool,
    destroyed: bool,
    response_listeners: Vec<HttpResponseListener>,
    error_listeners: Vec<HttpErrorListener>,
    close_listeners: Vec<HttpVoidListener>,
}

impl Trace for HttpClientRequestData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(socket) = &self.socket {
            tracer.edge(socket);
        }
        if let Some(connection) = &self.connection {
            connection.borrow().trace(tracer);
        }
        if let Some(agent) = &self.agent {
            tracer.edge(agent);
        }
        for listener in &self.response_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.error_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.close_listeners {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for HttpClientRequestData {
    fn clear_edges(&mut self) {
        self.socket = None;
        self.connection = None;
        self.agent = None;
        self.headers.clear();
        self.body.clear();
        self.sent = true;
        self.destroyed = true;
        self.response_listeners.clear();
        self.error_listeners.clear();
        self.close_listeners.clear();
    }
}

pub type JsHttpClientRequest = Gc<HttpClientRequestData>;

fn http_timeout_index(selector: f64) -> usize {
    let index = selector as usize;
    if selector.trunc() != selector || index >= 5 {
        unreachable!("scriptc invariant: invalid HTTP server timeout selector");
    }
    index
}

fn http_timeout_name(index: usize) -> &'static str {
    [
        "timeout",
        "keepAliveTimeout",
        "headersTimeout",
        "requestTimeout",
        "keepAliveTimeoutBuffer",
    ][index]
}

pub fn http_server_timeout_selector(name: &str) -> Option<f64> {
    match name {
        "timeout" => Some(0.0),
        "keepAliveTimeout" => Some(1.0),
        "headersTimeout" => Some(2.0),
        "requestTimeout" => Some(3.0),
        "keepAliveTimeoutBuffer" => Some(4.0),
        _ => None,
    }
}

pub fn http_server_new() -> JsNetServer {
    let server = net_server_new();
    server.with_mut(|server| {
        server.http = Some(HttpServerState {
            timeouts: [
                JsHttpTimeout::Number(0.0),
                JsHttpTimeout::Number(5_000.0),
                JsHttpTimeout::Number(60_000.0),
                JsHttpTimeout::Number(300_000.0),
                JsHttpTimeout::Number(1_000.0),
            ],
            join_duplicate_headers: false,
            max_header_size: 16 * 1024,
            request_listeners: Vec::new(),
        });
    });
    server
}

pub fn http_server_new_callback(
    callback: Rc<dyn Fn(JsHttpRequest, JsHttpResponse)>,
    trace: NetTrace,
) -> JsNetServer {
    let server = http_server_new();
    server.with_mut(|server| {
        server
            .http
            .as_mut()
            .expect("scriptc invariant: request listener on a net.Server")
            .request_listeners
            .push(HttpRequestListener {
                invoke: callback,
                trace,
                once: false,
            });
    });
    server
}

pub fn http_server_on_request(
    server: &JsNetServer,
    callback: Rc<dyn Fn(JsHttpRequest, JsHttpResponse)>,
    trace: NetTrace,
    once: bool,
) {
    server.with_mut(|server| {
        server
            .http
            .as_mut()
            .expect("scriptc invariant: request listener on a net.Server")
            .request_listeners
            .push(HttpRequestListener { invoke: callback, trace, once });
    });
}

struct HttpServerConnection {
    server: JsNetServer,
    socket: JsNetSocket,
    buffer: Vec<u8>,
    request: Option<JsHttpRequest>,
    body_remaining: usize,
}

impl HttpServerConnection {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(&self.server);
        tracer.edge(&self.socket);
        if let Some(request) = &self.request {
            tracer.edge(request);
        }
    }
}

type ParsedHttpHead = (JsString, JsString, Vec<(JsString, JsString, JsString)>, usize);

fn http_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4)
}

fn http_parse_request_head(bytes: &[u8]) -> Option<ParsedHttpHead> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text[..text.len().saturating_sub(4)].split("\r\n");
    let mut request_line = lines.next()?.split_whitespace();
    let method = string(request_line.next()?);
    let url = string(request_line.next()?);
    let version = request_line.next()?;
    if request_line.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return None;
    }
    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    for line in lines {
        let (raw_name, raw_value) = line.split_once(':')?;
        let name = raw_name.trim();
        let value = raw_value.trim();
        if name.is_empty() {
            return None;
        }
        let lower = name.to_ascii_lowercase();
        if lower == "content-length" {
            content_length = value.parse().ok()?;
        }
        headers.push((string(name), string(&lower), string(value)));
    }
    Some((method, url, headers, content_length))
}

fn http_dispatch_data(request: &JsHttpRequest) {
    let (listeners, body) = request.with_mut(|request| {
        if request.paused || request.body.is_empty() ||
            (!request.flowing && request.data_listeners.is_empty())
        {
            return (Vec::new(), Vec::new());
        }
        if request.data_listeners.is_empty() {
            request.body.clear();
            return (Vec::new(), Vec::new());
        }
        let listeners = request.data_listeners.clone();
        request.data_listeners.retain(|listener| !listener.once);
        (listeners, std::mem::take(&mut request.body))
    });
    if body.is_empty() {
        return;
    }
    let chunk = bytes_from_elements(body);
    for listener in listeners {
        (listener.invoke)(chunk.clone());
    }
}

fn http_request_push(request: &JsHttpRequest, bytes: &[u8]) {
    request.with_mut(|request| request.body.extend_from_slice(bytes));
    http_dispatch_data(request);
}

fn http_request_finish(request: &JsHttpRequest) {
    request.with_mut(|request| request.finish_pending = true);
    http_dispatch_data(request);
    http_request_maybe_finish(request);
}

fn http_request_maybe_finish(request: &JsHttpRequest) {
    let listeners = request.with_mut(|request| {
        if request.ended || !request.finish_pending || request.paused || !request.body.is_empty() {
            return None;
        }
        request.ended = true;
        request.finish_pending = false;
        Some(std::mem::take(&mut request.end_listeners))
    });
    let Some(listeners) = listeners else { return; };
    for listener in listeners {
        (listener.invoke)();
    }
    request.with_mut(|request| request.data_listeners.clear());
}

fn http_server_feed(connection: &Rc<RefCell<HttpServerConnection>>, bytes: &[u8]) {
    let (listeners, request, response, body, finish) = {
        let mut connection = connection.borrow_mut();
        if let Some(request) = connection.request.clone() {
            let take = bytes.len().min(connection.body_remaining);
            connection.body_remaining -= take;
            (
                Vec::new(),
                request,
                None,
                bytes[..take].to_vec(),
                connection.body_remaining == 0,
            )
        } else {
            connection.buffer.extend_from_slice(bytes);
            let head_len = http_header_end(&connection.buffer);
            let max_header_size = connection.server.with(|server| {
                server
                    .http
                    .as_ref()
                    .expect("scriptc invariant: HTTP connection on a net.Server")
                    .max_header_size
            });
            if head_len.is_some_and(|length| length > max_header_size) ||
                (head_len.is_none() && connection.buffer.len() > max_header_size)
            {
                net_socket_end_str(
                    &connection.socket,
                    &string("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
                );
                connection.buffer.clear();
                return;
            }
            let Some(head_len) = head_len else {
                return;
            };
            let Some((method, url, headers, content_length)) =
                http_parse_request_head(&connection.buffer[..head_len])
            else {
                net_socket_destroy(&connection.socket);
                return;
            };
            let request = Gc::new(HttpRequestData {
                socket: Some(connection.socket.clone()),
                method,
                url,
                status_code: None,
                status_message: None,
                headers,
                body: Vec::new(),
                ended: false,
                finish_pending: false,
                paused: false,
                flowing: false,
                data_listeners: Vec::new(),
                end_listeners: Vec::new(),
            });
            let response = Gc::new(HttpResponseData {
                socket: Some(connection.socket.clone()),
                request: Some(request.clone()),
                status_code: 200.0,
                status_message: empty_string(),
                headers: Vec::new(),
                headers_sent: false,
                chunked: false,
                ended: false,
                corked: 0,
                cork_buffer: Vec::new(),
                cork_callbacks: Vec::new(),
                finish_listeners: Vec::new(),
                close_listeners: Vec::new(),
                destroyed: false,
            });
            let available = connection.buffer.len() - head_len;
            let take = available.min(content_length);
            let body = connection.buffer[head_len..head_len + take].to_vec();
            connection.body_remaining = content_length - take;
            let finish = connection.body_remaining == 0;
            connection.buffer.clear();
            connection.request = Some(request.clone());
            let listeners = connection.server.with_mut(|server| {
                let Some(http) = server.http.as_mut() else {
                    return Vec::new();
                };
                let listeners = http.request_listeners.clone();
                http.request_listeners.retain(|listener| !listener.once);
                listeners
            });
            (listeners, request, Some(response), body, finish)
        }
    };
    if let Some(response) = response {
        for listener in listeners {
            (listener.invoke)(request.clone(), response.clone());
        }
    }
    if !body.is_empty() {
        http_request_push(&request, &body);
    }
    if finish {
        http_request_finish(&request);
    }
}

fn http_server_accept(server: &JsNetServer, socket: &JsNetSocket) {
    let connection = Rc::new(RefCell::new(HttpServerConnection {
        server: server.clone(),
        socket: socket.clone(),
        buffer: Vec::new(),
        request: None,
        body_remaining: 0,
    }));
    let invoke_connection = connection.clone();
    let trace_connection = connection;
    net_socket_on_data(
        socket,
        Rc::new(move |chunk, _encoding_utf8| {
            let bytes = bytes_u8_values(&chunk);
            http_server_feed(&invoke_connection, &bytes);
        }),
        Rc::new(move |tracer| trace_connection.borrow().trace(tracer)),
        false,
    );
}

pub fn http_request_url(request: &JsHttpRequest) -> JsString {
    request.with(|request| request.url.clone())
}

pub fn http_request_method(request: &JsHttpRequest) -> JsString {
    request.with(|request| request.method.clone())
}

pub fn http_request_header(request: &JsHttpRequest, name: &JsString) -> Option<JsString> {
    request.with(|request| {
        request
            .headers
            .iter()
            .find(|(_, lower, _)| lower.as_ref() == name.to_ascii_lowercase())
            .map(|(_, _, value)| value.clone())
    })
}

pub fn http_request_headers(request: &JsHttpRequest) -> Vec<(JsString, JsString)> {
    request.with(|request| {
        let mut output = Vec::new();
        for (_, lower, value) in &request.headers {
            if output.iter().all(|(name, _): &(JsString, JsString)| name.as_ref() != lower.as_ref()) {
                output.push((lower.clone(), value.clone()));
            }
        }
        output
    })
}

pub fn http_request_status_code(request: &JsHttpRequest) -> Option<f64> {
    request.with(|request| request.status_code)
}

pub fn http_request_status_message(request: &JsHttpRequest) -> Option<JsString> {
    request.with(|request| request.status_message.clone())
}

pub fn http_request_on_data(
    request: &JsHttpRequest,
    callback: Rc<dyn Fn(JsBytes<u8>)>,
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
    request.with(|request| request.socket.as_ref().is_none_or(net_socket_destroyed))
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
            invoke: Rc::new(move |chunk| http_response_write_bytes(&write_response, &chunk)),
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

fn http_header_index(headers: &[(JsString, JsString)], name: &str) -> Option<usize> {
    headers.iter().position(|(stored, _)| stored.eq_ignore_ascii_case(name))
}

fn http_reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "unknown",
    }
}

pub fn http_response_status_get(response: &JsHttpResponse) -> f64 {
    response.with(|response| response.status_code)
}

pub fn http_response_status_set(response: &JsHttpResponse, status: f64) {
    response.with_mut(|response| response.status_code = status);
}

pub fn http_response_status_message_get(response: &JsHttpResponse) -> JsString {
    response.with(|response| {
        if response.status_message.is_empty() {
            string(http_reason_phrase(response.status_code as u16))
        } else {
            response.status_message.clone()
        }
    })
}

pub fn http_response_status_message_set(response: &JsHttpResponse, message: &JsString) {
    response.with_mut(|response| response.status_message = message.clone());
}

pub fn http_response_set_header(response: &JsHttpResponse, name: &JsString, value: &JsString) {
    response.with_mut(|response| {
        if let Some(index) = http_header_index(&response.headers, name) {
            response.headers[index] = (name.clone(), value.clone());
        } else {
            response.headers.push((name.clone(), value.clone()));
        }
    });
}

pub fn http_response_get_header(response: &JsHttpResponse, name: &JsString) -> Option<JsString> {
    response.with(|response| {
        http_header_index(&response.headers, name)
            .map(|index| response.headers[index].1.clone())
    })
}

pub fn http_response_has_header(response: &JsHttpResponse, name: &JsString) -> bool {
    response.with(|response| http_header_index(&response.headers, name).is_some())
}

pub fn http_response_remove_header(response: &JsHttpResponse, name: &JsString) {
    response.with_mut(|response| {
        if !response.headers_sent {
            response.headers.retain(|(stored, _)| !stored.eq_ignore_ascii_case(name));
        }
    });
}

pub fn http_response_get_headers(response: &JsHttpResponse) -> Vec<(JsString, JsString)> {
    response.with(|response| {
        response
            .headers
            .iter()
            .map(|(name, value)| (string(&name.to_ascii_lowercase()), value.clone()))
            .collect()
    })
}

pub fn http_response_request(response: &JsHttpResponse) -> Option<JsHttpRequest> {
    response.with(|response| response.request.clone())
}

pub fn http_response_write_head(response: &JsHttpResponse, status: f64) {
    response.with_mut(|response| {
        if !response.headers_sent {
            response.status_code = status;
        }
    });
    if let Some((socket, head)) = http_response_head(response, None) {
        net_socket_queue(&socket, head);
    }
}

pub fn http_response_write_head_n(
    response: &JsHttpResponse,
    status: f64,
    names: &JsArray<JsString>,
    values: &JsArray<JsString>,
) {
    let length = array_len(names).min(array_len(values)) as usize;
    for index in 0..length {
        let name = array_get(names, index as f64);
        let value = array_get(values, index as f64);
        http_response_set_header(response, &name, &value);
    }
    http_response_write_head(response, status);
}

pub fn http_response_write_str(response: &JsHttpResponse, value: &JsString) {
    http_response_write_raw(response, value.as_bytes());
}

pub fn http_response_write_bytes(response: &JsHttpResponse, value: &JsBytes<u8>) {
    http_response_write_raw(response, &bytes_u8_values(value));
}

fn http_response_head(
    response: &JsHttpResponse,
    body_length: Option<usize>,
) -> Option<(JsNetSocket, Vec<u8>)> {
    response.with_mut(|response| {
        if response.ended || response.headers_sent {
            return None;
        }
        response.headers_sent = true;
        let status = response.status_code as u16;
        let reason = if response.status_message.is_empty() {
            http_reason_phrase(status)
        } else {
            response.status_message.as_ref()
        };
        let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
        for (name, value) in &response.headers {
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
            head.push_str("\r\n");
        }
        if http_header_index(&response.headers, "content-length").is_none() &&
            http_header_index(&response.headers, "transfer-encoding").is_none()
        {
            if let Some(length) = body_length {
                head.push_str(&format!("Content-Length: {length}\r\n"));
            } else {
                head.push_str("Transfer-Encoding: chunked\r\n");
                response.chunked = true;
            }
        } else {
            response.chunked = response.headers.iter().any(|(name, value)| {
                name.eq_ignore_ascii_case("transfer-encoding") &&
                    value.split(',').any(|token| token.trim().eq_ignore_ascii_case("chunked"))
            });
        }
        if http_header_index(&response.headers, "connection").is_none() {
            head.push_str("Connection: close\r\n");
        }
        head.push_str("\r\n");
        response.socket.clone().map(|socket| (socket, head.into_bytes()))
    })
}

fn http_chunk(bytes: &[u8]) -> Vec<u8> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut chunk = format!("{:x}\r\n", bytes.len()).into_bytes();
    chunk.extend_from_slice(bytes);
    chunk.extend_from_slice(b"\r\n");
    chunk
}

fn http_response_write_raw(response: &JsHttpResponse, bytes: &[u8]) {
    if response.with_mut(|response| {
        if response.corked == 0 {
            false
        } else {
            response.cork_buffer.extend_from_slice(bytes);
            true
        }
    }) {
        return;
    }
    if let Some((socket, head)) = http_response_head(response, None) {
        net_socket_queue(&socket, head);
    }
    let target = response.with(|response| {
        if response.ended {
            None
        } else {
            response.socket.clone().map(|socket| (socket, response.chunked))
        }
    });
    let Some((socket, chunked)) = target else {
        return;
    };
    let output = if chunked { http_chunk(bytes) } else { bytes.to_vec() };
    net_socket_queue(&socket, output);
}

fn http_response_end_raw(response: &JsHttpResponse, tail: &[u8]) {
    http_response_flush_cork(response);
    let fresh = http_response_head(response, Some(tail.len()));
    let target = response.with_mut(|response| {
        if response.ended {
            return None;
        }
        response.ended = true;
        response.socket.clone().map(|socket| (socket, response.chunked))
    });
    let Some((socket, chunked)) = target else {
        return;
    };
    if let Some((_, mut head)) = fresh {
        head.extend_from_slice(tail);
        net_socket_queue(&socket, head);
    } else if chunked {
        let mut output = http_chunk(tail);
        output.extend_from_slice(b"0\r\n\r\n");
        net_socket_queue(&socket, output);
    } else {
        net_socket_queue(&socket, tail.to_vec());
    }
    let finish_listeners = response.with_mut(|response| std::mem::take(&mut response.finish_listeners));
    for listener in finish_listeners {
        net_socket_on_finish(&socket, listener.invoke, listener.trace);
    }
    let invoke_response = response.clone();
    let trace_response = response.clone();
    net_socket_on_finish(
        &socket,
        Rc::new(move || {
            let listeners = invoke_response.with_mut(|response| {
                response.destroyed = true;
                response.socket = None;
                std::mem::take(&mut response.close_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
            invoke_response.with_mut(|response| response.request = None);
        }),
        Rc::new(move |tracer| tracer.edge(&trace_response)),
    );
    net_socket_end(&socket);
}

pub fn http_response_end(response: &JsHttpResponse) {
    http_response_end_raw(response, &[]);
}

pub fn http_response_end_str(response: &JsHttpResponse, value: &JsString) {
    http_response_end_raw(response, value.as_bytes());
}

pub fn http_response_end_bytes(response: &JsHttpResponse, value: &JsBytes<u8>) {
    http_response_end_raw(response, &bytes_u8_values(value));
}

pub fn http_response_headers_sent(response: &JsHttpResponse) -> bool {
    response.with(|response| response.headers_sent)
}

pub fn http_response_flush_headers(response: &JsHttpResponse) {
    http_response_write_head(response, http_response_status_get(response));
}

pub fn http_response_cork(response: &JsHttpResponse) {
    response.with_mut(|response| response.corked = response.corked.saturating_add(1));
}

pub fn http_response_uncork(response: &JsHttpResponse) {
    let flush = response.with_mut(|response| {
        response.corked = response.corked.saturating_sub(1);
        response.corked == 0
    });
    if flush {
        http_response_flush_cork(response);
    }
}

fn http_response_flush_cork(response: &JsHttpResponse) {
    let (bytes, callbacks) = response.with_mut(|response| {
        response.corked = 0;
        (
            std::mem::take(&mut response.cork_buffer),
            std::mem::take(&mut response.cork_callbacks),
        )
    });
    if !bytes.is_empty() {
        http_response_write_raw(response, &bytes);
    }
    if callbacks.is_empty() {
        return;
    }
    let socket = response.with(|response| response.socket.clone());
    if let Some(socket) = socket {
        let traced = callbacks.clone();
        net_socket_after_write(
            &socket,
            Rc::new(move || {
                for listener in &callbacks {
                    (listener.invoke)();
                }
            }),
            Rc::new(move |tracer| {
                for listener in &traced {
                    (listener.trace)(tracer);
                }
            }),
        );
    }
}

pub fn http_response_after_write(
    response: &JsHttpResponse,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    let listener = HttpVoidListener { invoke: callback, trace };
    let socket = response.with_mut(|response| {
        if response.corked > 0 {
            response.cork_callbacks.push(listener.clone());
            None
        } else {
            response.socket.clone()
        }
    });
    if let Some(socket) = socket {
        net_socket_after_write(&socket, listener.invoke, listener.trace);
    }
}

pub fn http_response_on_finish(
    response: &JsHttpResponse,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    response.with_mut(|response| {
        response.finish_listeners.push(HttpVoidListener { invoke: callback, trace });
    });
}

pub fn http_response_on_close(
    response: &JsHttpResponse,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    response.with_mut(|response| {
        if !response.destroyed {
            response.close_listeners.push(HttpVoidListener { invoke: callback, trace });
        }
    });
}

pub fn http_response_writable_corked(response: &JsHttpResponse) -> f64 {
    response.with(|response| response.corked as f64)
}

pub fn http_response_writable_finished(response: &JsHttpResponse) -> bool {
    response.with(|response| response.ended)
}

pub fn http_response_destroyed(response: &JsHttpResponse) -> bool {
    response.with(|response| {
        response.destroyed || response.socket.as_ref().is_none_or(net_socket_destroyed)
    })
}

pub fn http_server_join_duplicate_headers(server: &JsNetServer) {
    server.with_mut(|server| {
        server
            .http
            .as_mut()
            .expect("scriptc invariant: HTTP options on a net.Server")
            .join_duplicate_headers = true;
    });
}

pub fn http_server_max_header_size_set(server: &JsNetServer, value: f64) {
    if !value.is_finite() || value.trunc() != value {
        throw_range_error_code(
            format!(
                "The value of \"maxHeaderSize\" is out of range. It must be an integer. Received {}",
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    if !(0.0..=9_007_199_254_740_991.0).contains(&value) {
        throw_range_error_code(
            format!(
                "The value of \"maxHeaderSize\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    server.with_mut(|server| {
        server
            .http
            .as_mut()
            .expect("scriptc invariant: HTTP options on a net.Server")
            .max_header_size = value as usize;
    });
}

pub fn http_server_timeout_get(server: &JsNetServer, selector: f64) -> f64 {
    let index = http_timeout_index(selector);
    server.with(|server| match &server
        .http
        .as_ref()
        .expect("scriptc invariant: HTTP timeout read on a net.Server")
        .timeouts[index]
    {
        JsHttpTimeout::Number(value) => *value,
        JsHttpTimeout::Undefined => throw_type_error_code(
            format!(
                "The \"{}\" argument must be of type number. Received undefined",
                http_timeout_name(index)
            ),
            "ERR_INVALID_ARG_TYPE",
        ),
        JsHttpTimeout::String(value) => throw_type_error_code(
            format!(
                "The \"{}\" argument must be of type number. Received {}",
                http_timeout_name(index),
                dynamic_specific_string(value)
            ),
            "ERR_INVALID_ARG_TYPE",
        ),
    })
}

pub fn http_server_timeout_set(server: &JsNetServer, selector: f64, value: f64) {
    let index = http_timeout_index(selector);
    server.with_mut(|server| {
        server
            .http
            .as_mut()
            .expect("scriptc invariant: HTTP timeout write on a net.Server")
            .timeouts[index] = JsHttpTimeout::Number(value);
    });
}

pub fn http_server_timeout_option_set(server: &JsNetServer, selector: f64, value: Option<f64>) {
    let Some(value) = value else {
        return;
    };
    if !value.is_finite() || value.trunc() != value || !(0.0..=9_007_199_254_740_991.0).contains(&value) {
        throw_range_error_code(
            format!(
                "The value of \"{}\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
                http_timeout_name(http_timeout_index(selector)),
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    http_server_timeout_set(server, selector, value);
}

pub fn http_server_timeout_value(server: &JsNetServer, selector: f64) -> Option<JsHttpTimeout> {
    let index = http_timeout_index(selector);
    server.with(|server| server.http.as_ref().map(|http| http.timeouts[index].clone()))
}

pub fn http_server_timeout_set_string(server: &JsNetServer, selector: f64, value: &JsString) -> bool {
    http_server_timeout_set_value(server, selector, JsHttpTimeout::String(value.clone()))
}

pub fn http_server_timeout_set_number_dynamic(
    server: &JsNetServer,
    selector: f64,
    value: f64,
) -> bool {
    http_server_timeout_set_value(server, selector, JsHttpTimeout::Number(value))
}

pub fn http_server_timeout_set_undefined(server: &JsNetServer, selector: f64) -> bool {
    http_server_timeout_set_value(server, selector, JsHttpTimeout::Undefined)
}

fn http_server_timeout_set_value(
    server: &JsNetServer,
    selector: f64,
    value: JsHttpTimeout,
) -> bool {
    let index = http_timeout_index(selector);
    server.with_mut(|server| {
        let Some(http) = server.http.as_mut() else {
            return false;
        };
        http.timeouts[index] = value;
        true
    })
}
