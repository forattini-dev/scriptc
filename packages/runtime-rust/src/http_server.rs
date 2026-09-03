// The incoming-request stream (shared with the HTTP client's responses) and
// the HTTP/1.1 server connection: request framing over a socket's byte
// stream, pipelined request dispatch, and per-request state resets.

struct HttpServerConnection {
    server: JsNetServer,
    socket: JsNetSocket,
    buffer: Vec<u8>,
    request: Option<JsHttpRequest>,
    body_remaining: usize,
    chunked: bool,
    chunk_remaining: Option<usize>,
    keep_alive: bool,
    stopped: bool,
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
    let request = request.clone();
    process_next_tick(Box::new(move || http_request_dispatch_close(&request)));
}

/// One unit of progress over a connection's buffer. Every variant that runs
/// user JavaScript is handed back to `http_server_feed` so the connection's
/// `RefCell` borrow is released before re-entrant calls (write, end, destroy).
enum HttpServerStep {
    Idle,
    Dispatch(Vec<HttpRequestListener>, JsHttpRequest, JsHttpResponse),
    Body(JsHttpRequest, Vec<u8>),
    Finish(JsHttpRequest),
    Reject(&'static str),
    Destroy,
}

fn http_server_max_header_size(connection: &HttpServerConnection) -> usize {
    connection.server.with(|server| {
        server
            .http
            .as_ref()
            .expect("scriptc invariant: HTTP connection on a net.Server")
            .max_header_size
    })
}

fn http_server_reject(connection: &mut HttpServerConnection, reply: &'static str) -> HttpServerStep {
    connection.stopped = true;
    connection.buffer.clear();
    connection.request = None;
    connection.chunk_remaining = None;
    connection.chunked = false;
    connection.body_remaining = 0;
    HttpServerStep::Reject(reply)
}

/// Clears the per-request framing so the next pipelined head parses from a
/// clean state. A connection the client asked to close stops reading.
fn http_server_reset(connection: &mut HttpServerConnection) {
    connection.request = None;
    connection.chunked = false;
    connection.chunk_remaining = None;
    connection.body_remaining = 0;
    if !connection.keep_alive {
        connection.stopped = true;
        connection.buffer.clear();
    }
}

fn http_server_next(connection: &mut HttpServerConnection) -> HttpServerStep {
    if connection.stopped {
        connection.buffer.clear();
        return HttpServerStep::Idle;
    }
    if let Some(request) = connection.request.clone() {
        if connection.chunked {
            let limit = http_server_max_header_size(connection);
            return match http_chunked_step(
                &mut connection.buffer,
                &mut connection.chunk_remaining,
                limit,
            ) {
                HttpChunkStep::NeedMore => HttpServerStep::Idle,
                HttpChunkStep::Data(body) => HttpServerStep::Body(request, body),
                HttpChunkStep::Done => {
                    http_server_reset(connection);
                    HttpServerStep::Finish(request)
                }
                HttpChunkStep::Bad => http_server_reject(connection, HTTP_BAD_REQUEST_REPLY),
            };
        }
        if connection.body_remaining == 0 {
            http_server_reset(connection);
            return HttpServerStep::Finish(request);
        }
        if connection.buffer.is_empty() {
            return HttpServerStep::Idle;
        }
        let take = connection.body_remaining.min(connection.buffer.len());
        let body = connection.buffer.drain(..take).collect();
        connection.body_remaining -= take;
        return HttpServerStep::Body(request, body);
    }
    if connection.buffer.is_empty() {
        return HttpServerStep::Idle;
    }
    let head_len = http_header_end(&connection.buffer);
    let max_header_size = http_server_max_header_size(connection);
    if head_len.is_some_and(|length| length > max_header_size) ||
        (head_len.is_none() && connection.buffer.len() > max_header_size)
    {
        return http_server_reject(
            connection,
            "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
    }
    let Some(head_len) = head_len else {
        return HttpServerStep::Idle;
    };
    let Some(head) = http_parse_request_head(&connection.buffer[..head_len]) else {
        connection.stopped = true;
        connection.buffer.clear();
        return HttpServerStep::Destroy;
    };
    connection.buffer.drain(..head_len);
    match head.framing {
        HttpBodyFraming::Invalid => {
            return http_server_reject(connection, HTTP_BAD_REQUEST_REPLY);
        }
        HttpBodyFraming::Chunked => {
            connection.chunked = true;
            connection.chunk_remaining = None;
            connection.body_remaining = 0;
        }
        HttpBodyFraming::Length(length) => {
            connection.chunked = false;
            connection.body_remaining = length;
        }
    }
    connection.keep_alive = head.keep_alive;
    let request = Gc::new(HttpRequestData {
        fetch_response: false,
        fetch_body_used: false,
        socket: Some(connection.socket.clone()),
        method: head.method,
        url: head.url,
        http10: head.http10,
        status_code: None,
        status_message: None,
        headers: head.headers,
        body: Vec::new(),
        ended: false,
        aborted: false,
        destroyed: false,
        close_emitted: false,
        finish_pending: false,
        paused: false,
        flowing: false,
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        aborted_listeners: Vec::new(),
        close_listeners: Vec::new(),
    });
    let response = Gc::new(HttpResponseData {
        socket: Some(connection.socket.clone()),
        request: Some(request.clone()),
        status_code: 200.0,
        status_message: empty_string(),
        headers: Vec::new(),
        headers_sent: false,
        chunked: false,
        keep_alive: head.keep_alive,
        ended: false,
        corked: 0,
        cork_buffer: Vec::new(),
        cork_callbacks: Vec::new(),
        finish_listeners: Vec::new(),
        close_listeners: Vec::new(),
        destroyed: false,
    });
    connection.request = Some(request.clone());
    let listeners = connection.server.with_mut(|server| {
        let Some(http) = server.http.as_mut() else {
            return Vec::new();
        };
        let listeners = http.request_listeners.clone();
        http.request_listeners.retain(|listener| !listener.once);
        listeners
    });
    HttpServerStep::Dispatch(listeners, request, response)
}

fn http_server_feed(connection: &Rc<RefCell<HttpServerConnection>>, bytes: &[u8]) {
    connection.borrow_mut().buffer.extend_from_slice(bytes);
    loop {
        let step = http_server_next(&mut connection.borrow_mut());
        match step {
            HttpServerStep::Idle => return,
            HttpServerStep::Destroy => {
                let socket = connection.borrow().socket.clone();
                net_socket_destroy(&socket);
                return;
            }
            HttpServerStep::Reject(reply) => {
                let socket = connection.borrow().socket.clone();
                net_socket_end_str(&socket, &string(reply));
                return;
            }
            HttpServerStep::Dispatch(listeners, request, response) => {
                for listener in listeners {
                    (listener.invoke)(request.clone(), response.clone());
                }
            }
            HttpServerStep::Body(request, body) => {
                if !body.is_empty() {
                    http_request_push(&request, &body);
                }
            }
            HttpServerStep::Finish(request) => http_request_finish(&request),
        }
    }
}

fn http_server_accept(server: &JsNetServer, socket: &JsNetSocket) {
    let connection = Rc::new(RefCell::new(HttpServerConnection {
        server: server.clone(),
        socket: socket.clone(),
        buffer: Vec::new(),
        request: None,
        body_remaining: 0,
        chunked: false,
        chunk_remaining: None,
        keep_alive: false,
        stopped: false,
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
