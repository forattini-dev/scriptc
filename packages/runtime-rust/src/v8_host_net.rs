// The V8 island's socket, http, fetch and zlib host members — the same
// seams island_host_net.rs / island_host_http.rs / island_fetch.rs serve
// the boa realm, over the same `net_*` / `http_*` runtime primitives the
// static lane lowers to. Included by lib.rs right after v8_host.rs.
//
// The reentry rule is the boa lane's: a host member runs inside an
// engine entry and only mints handles and files listeners; the listeners
// fire later from the event loop, where `v8_callback` re-enters the
// engine, calls one method on the shim's callbacks object and drains the
// microtasks it queued. Identity is an integer: the shim speaks in
// socket/server/exchange ids and this file owns the id → handle maps,
// which `v8_net_reset` drops on teardown.

/// One live island socket: the runtime handle plus whether the shim has
/// asked for flow yet (a Node socket is paused until something reads it).
struct V8NetSocketEntry {
    socket: JsNetSocket,
    resumed: bool,
}

/// One in-flight served request/response pair, addressed by exchange id.
struct V8HttpExchange {
    request: JsHttpRequest,
    response: JsHttpResponse,
}

/// One in-flight client exchange.
struct V8HttpClientEntry {
    request: JsHttpClientRequest,
    /// Set once close, error or teardown retired the exchange — shared
    /// with the timeout timer so a late fire cannot resurrect it.
    settled: Rc<Cell<bool>>,
    /// Kept so `httpSetTimeout` after the start can re-arm.
    callbacks: v8e::Value,
}

thread_local! {
    static V8_NET_SOCKETS: RefCell<HashMap<u64, V8NetSocketEntry>> = RefCell::new(HashMap::new());
    static V8_NET_SERVERS: RefCell<HashMap<u64, JsNetServer>> = RefCell::new(HashMap::new());
    /// The callbacks object each server was created with, so a FAILED
    /// `listen` still has somewhere to report.
    static V8_NET_SERVER_CALLBACKS: RefCell<HashMap<u64, v8e::Value>> = RefCell::new(HashMap::new());
    static V8_NET_NEXT_ID: Cell<u64> = const { Cell::new(0) };
    static V8_HTTP_EXCHANGES: RefCell<HashMap<u64, V8HttpExchange>> = RefCell::new(HashMap::new());
    static V8_HTTP_CLIENTS: RefCell<HashMap<u64, V8HttpClientEntry>> = RefCell::new(HashMap::new());
    static V8_FETCH_REQUESTS: RefCell<HashMap<u64, JsHttpClientRequest>> = RefCell::new(HashMap::new());
}

fn v8_net_next_id() -> u64 {
    V8_NET_NEXT_ID.with(|slot| {
        let id = slot.get().checked_add(1).unwrap_or(1);
        slot.set(id);
        id
    })
}

/// Release every socket, server and exchange before the realm goes down.
fn v8_net_reset() {
    let sockets = V8_NET_SOCKETS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    for entry in sockets.into_values() {
        net_socket_destroy(&entry.socket);
    }
    let servers = V8_NET_SERVERS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    for server in servers.into_values() {
        net_server_close_direct(&server);
    }
    V8_NET_SERVER_CALLBACKS.with(|slot| slot.borrow_mut().clear());
    V8_HTTP_EXCHANGES.with(|slot| slot.borrow_mut().clear());
    let clients = V8_HTTP_CLIENTS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    for entry in clients.into_values() {
        entry.settled.set(true);
        http_client_destroy(&entry.request);
    }
    let requests = V8_FETCH_REQUESTS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    for request in requests.into_values() {
        http_client_destroy(&request);
    }
    V8_NET_NEXT_ID.with(|slot| slot.set(0));
}

/// `args[index]` as a registry id, or 0 when the shim passed none.
fn arg_id(args: &[v8e::Value], index: usize) -> u64 {
    let value = v8e::as_number(&arg(args, index)).unwrap_or(0.0);
    if value.is_finite() && value >= 1.0 && value.fract() == 0.0 { value as u64 } else { 0 }
}

fn arg_callbacks(args: &[v8e::Value], index: usize) -> Result<v8e::Value, v8e::Error> {
    let value = arg(args, index);
    if v8e::is_object(&value) { Ok(value) } else { Err(type_error("the island socket bridge expects a callbacks object")) }
}

fn arg_is_nullish(args: &[v8e::Value], index: usize) -> bool {
    let value = arg(args, index);
    v8e::is_undefined(&value) || v8e::is_null(&value)
}

/// `v8_callback` that also answers what the shim returned (the
/// `onConnection`/`onRequest` wiring objects).
fn v8_callback_answer(callbacks: &v8e::Value, name: &str, args: Vec<v8e::Value>) -> v8e::Value {
    let member = ok(v8e::get(callbacks, name));
    if !v8e::is_function(&member) {
        return v8e::undefined();
    }
    let answer = match v8e::call(&member, Some(callbacks), &args) {
        Ok(answer) => answer,
        Err(error) => {
            v8_throw(error);
        }
    };
    v8e::run_microtasks();
    answer
}

fn v8_net_socket(id: u64) -> Option<JsNetSocket> {
    V8_NET_SOCKETS.with(|sockets| sockets.borrow().get(&id).map(|entry| entry.socket.clone()))
}

fn v8_net_server(id: u64) -> Option<JsNetServer> {
    V8_NET_SERVERS.with(|servers| servers.borrow().get(&id).cloned())
}

/// `[address, family, port]` — the row the shim destructures.
fn v8_address_row(address: Option<std::net::SocketAddr>) -> v8e::Value {
    let Some(address) = address else { return v8e::undefined() };
    let family = if address.is_ipv6() { "IPv6" } else { "IPv4" };
    v8e::array(&[v8e::string(&address.ip().to_string()), v8e::string(family), v8e::number(f64::from(address.port()))])
}

fn v8_socket_peer(socket: &JsNetSocket) -> Option<std::net::SocketAddr> {
    socket.with(|socket| socket.stream.as_ref().and_then(|stream| stream.peer_addr().ok()))
}

fn v8_chunk_value(chunk: &JsBytes<u8>) -> v8e::Value {
    v8e::bytes(&bytes_u8_values(chunk))
}

/* ── socket wiring ─────────────────────────────────────────────────── */

fn v8_net_wire_socket(socket: &JsNetSocket, id: u64, callbacks: &v8e::Value) {
    let connect_callbacks = callbacks.clone();
    net_socket_on_connect(socket, Rc::new(move || v8_callback(&connect_callbacks, "onConnect", Vec::new())), Rc::new(|_| {}), true);
    let data_callbacks = callbacks.clone();
    net_socket_on_data(socket, Rc::new(move |chunk, _utf8| v8_callback(&data_callbacks, "onData", vec![v8_chunk_value(&chunk)])), Rc::new(|_| {}), false);
    let end_callbacks = callbacks.clone();
    net_socket_on_end(socket, Rc::new(move || v8_callback(&end_callbacks, "onEnd", Vec::new())), Rc::new(|_| {}), true);
    let error_callbacks = callbacks.clone();
    net_socket_on_error(
        socket,
        Rc::new(move |error| v8_callback(&error_callbacks, "onError", vec![v8e::string(&error_message(&error))])),
        Rc::new(|_| {}),
        false,
    );
    let close_callbacks = callbacks.clone();
    net_socket_on_close(
        socket,
        Rc::new(move || {
            V8_NET_SOCKETS.with(|sockets| sockets.borrow_mut().remove(&id));
            v8_callback(&close_callbacks, "onClose", Vec::new());
        }),
        Rc::new(|_| {}),
        true,
    );
}

/// Register a socket and re-pause it unless the shim already read.
fn v8_net_adopt(socket: &JsNetSocket, id: u64, callbacks: &v8e::Value) {
    v8_net_wire_socket(socket, id, callbacks);
    let resumed = V8_NET_SOCKETS.with(|sockets| {
        sockets
            .borrow_mut()
            .entry(id)
            .and_modify(|entry| entry.socket = socket.clone())
            .or_insert_with(|| V8NetSocketEntry { socket: socket.clone(), resumed: false })
            .resumed
    });
    if resumed { net_socket_resume(socket); } else { net_socket_pause(socket); }
}

/* ── the socket host functions ─────────────────────────────────────── */

fn host_net_connect(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let port = arg_number(args, 0)?;
    let hostname = arg_js_string(args, 1)?;
    let callbacks = arg_callbacks(args, 2)?;
    let socket = v8_guard(|| net_socket_connect(port, &hostname))?;
    let id = v8_net_next_id();
    v8_net_adopt(&socket, id, &callbacks);
    Ok(v8e::HostResult::Number(id as f64))
}

fn host_net_write(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(socket) = v8_net_socket(arg_id(args, 0)) else { return Ok(v8e::HostResult::Bool(false)) };
    let bytes = arg_bytes(args, 1)?;
    v8_guard(|| net_socket_write_bytes(&socket, &bytes))?;
    Ok(v8e::HostResult::Bool(true))
}

fn host_net_end(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(socket) = v8_net_socket(arg_id(args, 0)) else { return Ok(v8e::HostResult::Undefined) };
    if arg_is_nullish(args, 1) {
        v8_guard(|| net_socket_end(&socket))?;
    } else {
        let bytes = arg_bytes(args, 1)?;
        v8_guard(|| net_socket_end_bytes(&socket, &bytes))?;
    }
    Ok(v8e::HostResult::Undefined)
}

fn host_net_destroy(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    if let Some(socket) = v8_net_socket(arg_id(args, 0)) {
        net_socket_destroy(&socket);
    }
    Ok(v8e::HostResult::Undefined)
}

fn host_net_flow(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let id = arg_id(args, 0);
    let resume = arg_bool(args, 1);
    let socket = V8_NET_SOCKETS.with(|sockets| {
        let mut sockets = sockets.borrow_mut();
        let entry = sockets.get_mut(&id)?;
        entry.resumed = resume;
        Some(entry.socket.clone())
    });
    if let Some(socket) = socket {
        if resume { net_socket_resume(&socket); } else { net_socket_pause(&socket); }
    }
    Ok(v8e::HostResult::Undefined)
}

fn host_net_option(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(socket) = v8_net_socket(arg_id(args, 0)) else { return Ok(v8e::HostResult::Bool(false)) };
    let name = arg_string(args, 1)?;
    let enabled = arg_bool(args, 2);
    let applied = match name.as_str() {
        "noDelay" => {
            net_socket_set_no_delay(&socket, enabled);
            true
        }
        "keepAlive" => v8_net_set_keep_alive(&socket, enabled),
        _ => false,
    };
    Ok(v8e::HostResult::Bool(applied))
}

#[cfg(all(not(windows), not(target_os = "wasi")))]
fn v8_net_set_keep_alive(socket: &JsNetSocket, enabled: bool) -> bool {
    socket.with(|socket| socket.stream.as_ref().is_some_and(|stream| rustix::net::sockopt::set_socket_keepalive(stream, enabled).is_ok()))
}

#[cfg(any(windows, target_os = "wasi"))]
fn v8_net_set_keep_alive(_socket: &JsNetSocket, _enabled: bool) -> bool {
    false
}

fn host_net_peer(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(socket) = v8_net_socket(arg_id(args, 0)) else { return Ok(v8e::HostResult::Undefined) };
    host_value(v8_address_row(v8_socket_peer(&socket)))
}

fn host_net_local(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(socket) = v8_net_socket(arg_id(args, 0)) else { return Ok(v8e::HostResult::Undefined) };
    let local = socket.with(|socket| socket.stream.as_ref().and_then(|stream| stream.local_addr().ok()));
    host_value(v8_address_row(local))
}

/* ── the server host functions ─────────────────────────────────────── */

fn v8_server_register(id: u64, server: JsNetServer, callbacks: &v8e::Value) {
    let listening_callbacks = callbacks.clone();
    net_server_on_listening(&server, Rc::new(move || v8_callback(&listening_callbacks, "onListening", Vec::new())), Rc::new(|_| {}), false);
    let close_callbacks = callbacks.clone();
    net_server_on_close(&server, Rc::new(move || v8_callback(&close_callbacks, "onClose", Vec::new())), Rc::new(|_| {}), false);
    V8_NET_SERVERS.with(|servers| servers.borrow_mut().insert(id, server));
    V8_NET_SERVER_CALLBACKS.with(|slot| slot.borrow_mut().insert(id, callbacks.clone()));
}

/// `host.netServerCreate(callbacks)` → a server id. `onConnection(id,
/// addressRow)` RETURNS the accepted socket's callbacks object.
fn host_net_server_create(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let callbacks = arg_callbacks(args, 0)?;
    let server = net_server_new();
    let id = v8_net_next_id();
    let connection_callbacks = callbacks.clone();
    net_server_on_connection(
        &server,
        Rc::new(move |connection: JsNetSocket| {
            let socket_id = v8_net_next_id();
            V8_NET_SOCKETS.with(|sockets| {
                sockets.borrow_mut().insert(socket_id, V8NetSocketEntry { socket: connection.clone(), resumed: false });
            });
            let peer = v8_socket_peer(&connection);
            let answer = v8_callback_answer(&connection_callbacks, "onConnection", vec![v8e::number(socket_id as f64), v8_address_row(peer)]);
            if v8e::is_object(&answer) {
                v8_net_adopt(&connection, socket_id, &answer);
            } else {
                V8_NET_SOCKETS.with(|sockets| sockets.borrow_mut().remove(&socket_id));
                net_socket_destroy(&connection);
            }
        }),
        Rc::new(|_| {}),
        false,
    );
    v8_server_register(id, server, &callbacks);
    Ok(v8e::HostResult::Number(id as f64))
}

/// `host.netServerListen(id, port, host)`: a bind failure is Node's
/// ASYNCHRONOUS `'error'`, reported off a zero-delay timer.
fn host_net_server_listen(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let id = arg_id(args, 0);
    let Some(server) = v8_net_server(id) else { return Ok(v8e::HostResult::Undefined) };
    let port = arg_number(args, 1)?;
    let hostname: JsString = if arg_is_nullish(args, 2) { Rc::from("") } else { arg_js_string(args, 2)? };
    let listened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| net_server_listen_options(&server, port, &hostname, false)));
    if let Err(payload) = listened {
        if !is_scriptc_unwind(payload.as_ref()) {
            std::panic::resume_unwind(payload);
        }
        let message = caught_error_message(&caught_from_panic(payload)).to_string();
        let callbacks = V8_NET_SERVER_CALLBACKS.with(|slot| slot.borrow().get(&id).cloned());
        let mut once = callbacks.map(|callbacks| (callbacks, message));
        let fire: Box<dyn FnMut()> = Box::new(move || {
            if let Some((callbacks, message)) = once.take() {
                v8_callback(&callbacks, "onError", vec![v8e::string(&message)]);
            }
        });
        timer_set_timeout_handle(fire, 0.0);
    }
    Ok(v8e::HostResult::Undefined)
}

fn host_net_server_address(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(server) = v8_net_server(arg_id(args, 0)) else { return Ok(v8e::HostResult::Undefined) };
    let address = server.with(|server| server.listener.as_ref().and_then(|listener| listener.local_addr().ok()));
    host_value(v8_address_row(address))
}

fn host_net_server_close(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    if let Some(server) = v8_net_server(arg_id(args, 0)) {
        net_server_close_direct(&server);
    }
    Ok(v8e::HostResult::Undefined)
}

/* ── the node:http SERVER leg ──────────────────────────────────────── */

/// `rawHeaders` — name/value alternating, original case, repeats kept.
fn v8_raw_headers(request: &JsHttpRequest) -> v8e::Value {
    let pairs = request.with(|request| request.headers.iter().map(|(name, _lower, value)| (name.clone(), value.clone())).collect::<Vec<_>>());
    let flat: Vec<v8e::Value> = pairs.iter().flat_map(|(name, value)| [js_string(name), js_string(value)]).collect();
    v8e::array(&flat)
}

fn v8_http_exchange(id: u64) -> Option<(JsHttpRequest, JsHttpResponse)> {
    V8_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow().get(&id).map(|entry| (entry.request.clone(), entry.response.clone())))
}

fn host_srv_create(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let callbacks = arg_callbacks(args, 0)?;
    let server = http_server_new();
    let id = v8_net_next_id();
    let request_callbacks = callbacks.clone();
    http_server_on_request(
        &server,
        Rc::new(move |request: JsHttpRequest, response: JsHttpResponse| v8_http_exchange_begin(&request_callbacks, request, response)),
        Rc::new(|_| {}),
        false,
    );
    v8_server_register(id, server, &callbacks);
    Ok(v8e::HostResult::Number(id as f64))
}

/// Hand one accepted request to the realm and wire what comes back.
fn v8_http_exchange_begin(callbacks: &v8e::Value, request: JsHttpRequest, response: JsHttpResponse) {
    let id = v8_net_next_id();
    V8_HTTP_EXCHANGES.with(|exchanges| {
        exchanges.borrow_mut().insert(id, V8HttpExchange { request: request.clone(), response: response.clone() });
    });
    let method = http_request_method(&request);
    let url = http_request_url(&request);
    let peer = request.with(|request| request.socket.as_ref().and_then(v8_socket_peer));
    let peer = peer.map_or_else(v8e::undefined, |peer| v8e::string(&peer.ip().to_string()));
    // The server parser accepts HTTP/1.1 only, so that is the version the
    // shim reports.
    let answer = v8_callback_answer(
        callbacks,
        "onRequest",
        vec![v8e::number(id as f64), js_string(&method), js_string(&url), v8_raw_headers(&request), v8e::number(1.0), v8e::number(1.0), peer],
    );
    if !v8e::is_object(&answer) {
        V8_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow_mut().remove(&id));
        return;
    }
    let close_wiring = answer.clone();
    http_response_on_close(
        &response,
        Rc::new(move || {
            V8_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow_mut().remove(&id));
            v8_callback(&close_wiring, "onClose", Vec::new());
        }),
        Rc::new(|_| {}),
    );
    let end_wiring = answer.clone();
    http_request_on_end(&request, Rc::new(move || v8_callback(&end_wiring, "onEnd", Vec::new())), Rc::new(|_| {}), true);
    // Filing the data listener flushes what the parser already read, so
    // it goes last: `onEnd` must be reachable before the body arrives.
    let data_wiring = answer;
    http_request_on_data(&request, Rc::new(move |chunk, _utf8| v8_callback(&data_wiring, "onData", vec![v8_chunk_value(&chunk)])), Rc::new(|_| {}), false);
}

fn host_srv_port(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(server) = v8_net_server(arg_id(args, 0)) else { return Ok(v8e::HostResult::Number(0.0)) };
    Ok(v8e::HostResult::Number(net_server_port(&server)))
}

/// `host.srvResHead(id, status, statusMessage, flatHeaders)`: the flat
/// list REPLACES the response's headers (the shim owns the store).
fn host_srv_res_head(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some((_, response)) = v8_http_exchange(arg_id(args, 0)) else { return Ok(v8e::HostResult::Undefined) };
    let status = arg_number(args, 1)?;
    if !arg_is_nullish(args, 2) {
        let message = arg_js_string(args, 2)?;
        http_response_status_message_set(&response, &message);
    }
    let flat = arg_strings(args, 3)?;
    let length = array_len(&flat) as usize;
    let mut headers = Vec::with_capacity(length / 2);
    for index in (0..length.saturating_sub(1)).step_by(2) {
        headers.push((array_get(&flat, index as f64), array_get(&flat, (index + 1) as f64)));
    }
    response.with_mut(|response| {
        if !response.headers_sent {
            response.headers = headers;
        }
    });
    v8_guard(|| http_response_write_head(&response, status))?;
    Ok(v8e::HostResult::Undefined)
}

fn host_srv_res_write(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some((_, response)) = v8_http_exchange(arg_id(args, 0)) else { return Ok(v8e::HostResult::Bool(false)) };
    let bytes = arg_bytes(args, 1)?;
    v8_guard(|| http_response_write_bytes(&response, &bytes))?;
    Ok(v8e::HostResult::Bool(true))
}

fn host_srv_res_end(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some((_, response)) = v8_http_exchange(arg_id(args, 0)) else { return Ok(v8e::HostResult::Undefined) };
    if arg_is_nullish(args, 1) {
        v8_guard(|| http_response_end(&response))?;
    } else {
        let bytes = arg_bytes(args, 1)?;
        v8_guard(|| http_response_end_bytes(&response, &bytes))?;
    }
    Ok(v8e::HostResult::Undefined)
}

/// `req.destroy()` on a served request tears the CONNECTION down.
fn host_srv_res_destroy(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let id = arg_id(args, 0);
    let Some((request, _)) = v8_http_exchange(id) else { return Ok(v8e::HostResult::Undefined) };
    V8_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow_mut().remove(&id));
    if let Some(socket) = request.with(|request| request.socket.clone()) {
        net_socket_destroy(&socket);
    }
    Ok(v8e::HostResult::Undefined)
}

/* ── the node:http CLIENT leg ──────────────────────────────────────── */

fn v8_http_client(id: u64) -> Option<JsHttpClientRequest> {
    V8_HTTP_CLIENTS.with(|clients| clients.borrow().get(&id).map(|entry| entry.request.clone()))
}

/// Arm the shim's `request.setTimeout`: fires once if the exchange has
/// not settled by then (the idle reset is the documented divergence).
fn v8_http_client_arm_timeout(callbacks: &v8e::Value, settled: &Rc<Cell<bool>>, timeout: f64) {
    if !timeout.is_finite() || timeout <= 0.0 {
        return;
    }
    let callbacks = callbacks.clone();
    let settled = settled.clone();
    let mut armed = true;
    let fire: Box<dyn FnMut()> = Box::new(move || {
        if !armed || settled.get() {
            return;
        }
        armed = false;
        v8_callback(&callbacks, "onTimeout", Vec::new());
    });
    timer_set_timeout_handle(fire, timeout);
}

/// Wire the response side of a client exchange: head, then end, then
/// data (last, so `onEnd` is reachable before the buffered body flushes).
fn v8_http_response_wire(callbacks: &v8e::Value, response: &JsHttpRequest) {
    let status = http_request_status_code(response).unwrap_or(0.0);
    let status_text = http_request_status_message(response).unwrap_or_else(empty_string);
    v8_callback(callbacks, "onResponse", vec![v8e::number(status), js_string(&status_text), v8_raw_headers(response)]);
    let end_callbacks = callbacks.clone();
    http_request_on_end(response, Rc::new(move || v8_callback(&end_callbacks, "onEnd", Vec::new())), Rc::new(|_| {}), true);
    let data_callbacks = callbacks.clone();
    http_request_on_data(response, Rc::new(move |chunk, _utf8| v8_callback(&data_callbacks, "onData", vec![v8_chunk_value(&chunk)])), Rc::new(|_| {}), false);
}

/// `host.httpStart(secure, host, port, path, method, timeoutMs, headers,
/// callbacks)` → an exchange id. `secure` is fenced as on the boa lane.
fn host_http_start(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    if arg_bool(args, 0) {
        return Err(v8e::Error {
            name: "Error".to_owned(),
            message: "node:https requests are not supported in the scriptc Rust island yet (node:http is)".to_owned(),
            code: None,
            stack: None,
            value: None,
        });
    }
    let hostname = arg_js_string(args, 1)?;
    let port = arg_number(args, 2)?;
    let path = arg_js_string(args, 3)?;
    let method = arg_js_string(args, 4)?;
    let timeout = arg_number(args, 5)?;
    let headers = arg_strings(args, 6)?;
    let callbacks = arg_callbacks(args, 7)?;
    let id = v8_net_next_id();
    let settled = Rc::new(Cell::new(false));
    let response_callbacks = callbacks.clone();
    let response_callback = Rc::new(move |response: JsHttpRequest| v8_http_response_wire(&response_callbacks, &response));
    let request = v8_guard(|| {
        http_client_new(&hostname, port, &path, &method, false, timeout, &headers, false, true, &empty_string(), Some((response_callback, Rc::new(|_| {}))))
    })?;
    let error_callbacks = callbacks.clone();
    http_client_on_error(
        &request,
        Rc::new(move |error| v8_callback(&error_callbacks, "onError", vec![v8e::string(&error_message(&error))])),
        Rc::new(|_| {}),
        true,
    );
    let close_callbacks = callbacks.clone();
    http_client_on_close(
        &request,
        Rc::new(move || {
            if let Some(entry) = V8_HTTP_CLIENTS.with(|clients| clients.borrow_mut().remove(&id)) {
                entry.settled.set(true);
            }
            v8_callback(&close_callbacks, "onClose", Vec::new());
        }),
        Rc::new(|_| {}),
        true,
    );
    v8_http_client_arm_timeout(&callbacks, &settled, timeout);
    V8_HTTP_CLIENTS.with(move |clients| {
        clients.borrow_mut().insert(id, V8HttpClientEntry { request, settled, callbacks });
    });
    Ok(v8e::HostResult::Number(id as f64))
}

fn host_http_write(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(request) = v8_http_client(arg_id(args, 0)) else { return Ok(v8e::HostResult::Bool(false)) };
    let bytes = arg_bytes(args, 1)?;
    v8_guard(|| http_client_write_bytes(&request, &bytes))?;
    Ok(v8e::HostResult::Bool(true))
}

fn host_http_end(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let Some(request) = v8_http_client(arg_id(args, 0)) else { return Ok(v8e::HostResult::Undefined) };
    if arg_is_nullish(args, 1) {
        v8_guard(|| http_client_end(&request))?;
    } else {
        let bytes = arg_bytes(args, 1)?;
        v8_guard(|| http_client_end_bytes(&request, &bytes))?;
    }
    Ok(v8e::HostResult::Undefined)
}

fn host_http_destroy(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    if let Some(request) = v8_http_client(arg_id(args, 0)) {
        http_client_destroy(&request);
    }
    Ok(v8e::HostResult::Undefined)
}

fn host_http_set_timeout(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let id = arg_id(args, 0);
    let timeout = arg_number(args, 1)?;
    let entry = V8_HTTP_CLIENTS.with(|clients| clients.borrow().get(&id).map(|entry| (entry.request.clone(), entry.settled.clone(), entry.callbacks.clone())));
    let Some((request, settled, callbacks)) = entry else { return Ok(v8e::HostResult::Undefined) };
    request.with_mut(|request| request.timeout = timeout);
    v8_http_client_arm_timeout(&callbacks, &settled, timeout);
    Ok(v8e::HostResult::Undefined)
}

/* ── fetch ─────────────────────────────────────────────────────────── */

/// `host.fetch(url, method, flatHeaders, bodyBytes)` → `[promise, id]`;
/// the promise settles with `[status, statusText, url, flatHeaders,
/// bytes]` once the body is buffered (island_web.js owns Response).
fn host_fetch(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let url = arg_js_string(args, 0)?;
    let method = arg_js_string(args, 1)?;
    let headers = arg_strings(args, 2)?;
    let body = arg_bytes(args, 3)?;
    let protocol = v8_guard(|| url_protocol(&url_new(&url)))?;
    let secure = match protocol.as_ref() {
        "http:" => false,
        "https:" => true,
        _ => return Err(type_error(format!("fetch does not support protocol {protocol}"))),
    };
    let (promise, resolver) = v8e::promise_new();
    let id = v8_net_next_id();
    let resolve = Rc::new(resolver);
    let response_resolver = resolve.clone();
    let response_url = url.clone();
    let response_callback = Rc::new(move |response: JsHttpRequest| {
        let status = http_request_status_code(&response).unwrap_or(0.0);
        let status_text = http_request_status_message(&response).unwrap_or_else(empty_string);
        let headers = http_request_headers(&response);
        let body = Rc::new(RefCell::new(Vec::<u8>::new()));
        let body_data = body.clone();
        http_request_on_data(&response, Rc::new(move |chunk, _utf8| body_data.borrow_mut().extend(bytes_u8_values(&chunk))), Rc::new(|_| {}), false);
        let end_resolver = response_resolver.clone();
        let end_url = response_url.clone();
        http_request_on_end(
            &response,
            Rc::new(move || {
                V8_FETCH_REQUESTS.with(|requests| requests.borrow_mut().remove(&id));
                let flat: Vec<v8e::Value> = headers.iter().flat_map(|(name, value)| [js_string(name), js_string(value)]).collect();
                let row = v8e::array(&[v8e::number(status), js_string(&status_text), js_string(&end_url), v8e::array(&flat), v8e::bytes(&body.borrow())]);
                end_resolver.resolve(&row);
                v8e::run_microtasks();
            }),
            Rc::new(|_| {}),
            true,
        );
    });
    let request = v8_guard(|| {
        let (host, port, path) = http_client_url_parts(&url, secure);
        http_client_new(&host, port, &path, &method, secure, 0.0, &headers, false, true, &empty_string(), Some((response_callback, Rc::new(|_| {}))))
    })?;
    request.with_mut(|request| request.half_close_after_write = false);
    let error_resolver = resolve;
    http_client_on_error(
        &request,
        Rc::new(move |error| {
            V8_FETCH_REQUESTS.with(|requests| requests.borrow_mut().remove(&id));
            let error = v8_error_of_caught(&caught_value(error));
            error_resolver.reject(&v8e::error(&error.name, &error.message, error.code.as_deref()));
            v8e::run_microtasks();
        }),
        Rc::new(|_| {}),
        true,
    );
    V8_FETCH_REQUESTS.with(|requests| {
        requests.borrow_mut().insert(id, request.clone());
    });
    if bytes_len(&body) == 0.0 {
        http_client_end(&request);
    } else {
        http_client_end_bytes(&request, &body);
    }
    host_value(v8e::array(&[promise, v8e::number(id as f64)]))
}

fn host_fetch_cancel(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    if let Some(request) = V8_FETCH_REQUESTS.with(|requests| requests.borrow_mut().remove(&arg_id(args, 0))) {
        http_client_destroy(&request);
    }
    Ok(v8e::HostResult::Undefined)
}

/* ── zlib ──────────────────────────────────────────────────────────── */

/// `host.zlib(deflating, bytes, mode, level)`; `level` is accepted and
/// ignored, as on the boa lane (flate2 default compression).
fn host_zlib(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let deflating = arg_number(args, 0)? != 0.0;
    let data = arg_bytes(args, 1)?;
    let mode = arg_number(args, 2)? as i32;
    let output = v8_guard(|| match (deflating, mode) {
        (true, 1) => zlib_deflate_raw_sync(&data),
        (true, 2) => zlib_gzip_sync(&data),
        (true, _) => zlib_deflate_sync(&data),
        (false, 1) => zlib_inflate_raw_sync(&data),
        (false, 2) => zlib_gunzip_sync(&data),
        (false, 3) => zlib_unzip_sync(&data),
        (false, _) => zlib_inflate_sync(&data),
    })?;
    Ok(v8e::HostResult::Bytes(bytes_u8_values(&output)))
}
