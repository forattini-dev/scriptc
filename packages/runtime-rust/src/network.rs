thread_local! {
    static NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT: Cell<f64> = const { Cell::new(250.0) };
}

pub fn net_get_auto_select_family_attempt_timeout() -> f64 {
    NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT.with(Cell::get)
}

pub fn net_validate_attempt_timeout(value: f64, name: &str) {
    if !value.is_finite() || value.trunc() != value {
        throw_range_error_code(
            format!(
                "The value of \"{name}\" is out of range. It must be an integer. Received {}",
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    if !(1.0..=2_147_483_647.0).contains(&value) {
        throw_range_error_code(
            format!(
                "The value of \"{name}\" is out of range. It must be >= 1 && <= 2147483647. Received {}",
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
}

pub fn net_set_auto_select_family_attempt_timeout(value: f64) {
    net_validate_attempt_timeout(value, "value");
    NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT.with(|timeout| timeout.set(value.max(10.0)));
}

type NetTrace = Rc<dyn for<'a> Fn(&mut Tracer<'a>)>;

#[derive(Clone)]
struct NetVoidListener {
    invoke: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
}

#[derive(Clone)]
struct NetConnectionListener {
    invoke: Rc<dyn Fn(JsNetSocket)>,
    trace: NetTrace,
    once: bool,
}

#[derive(Clone)]
struct NetDataListener {
    invoke: Rc<dyn Fn(JsBytes<u8>, bool)>,
    trace: NetTrace,
    once: bool,
}

#[derive(Clone)]
struct NetErrorListener {
    invoke: Rc<dyn Fn(JsError)>,
    trace: NetTrace,
    once: bool,
}

struct NetWrite {
    bytes: Vec<u8>,
    callback: Option<NetVoidListener>,
}

pub struct NetSocketData {
    stream: Option<std::net::TcpStream>,
    pending_connect: Option<(String, u16)>,
    connect_rx: Option<std::sync::mpsc::Receiver<Result<std::net::TcpStream, String>>>,
    tls: Option<TlsSocketState>,
    server: Option<JsNetServer>,
    destroyed: bool,
    writable: bool,
    flowing: bool,
    encoding_utf8: bool,
    read_ended: bool,
    end_requested: bool,
    close_emitted: bool,
    bytes_written: usize,
    write_queue: VecDeque<NetWrite>,
    write_offset: usize,
    finish_listeners: Vec<NetVoidListener>,
    data_listeners: Vec<NetDataListener>,
    end_listeners: Vec<NetVoidListener>,
    close_listeners: Vec<NetVoidListener>,
    connect_listeners: Vec<NetVoidListener>,
    error_listeners: Vec<NetErrorListener>,
}

impl Trace for NetSocketData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(server) = &self.server {
            tracer.edge(server);
        }
        for listener in &self.data_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.end_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.close_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.connect_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.error_listeners {
            (listener.trace)(tracer);
        }
        for write in &self.write_queue {
            if let Some(listener) = &write.callback {
                (listener.trace)(tracer);
            }
        }
        for listener in &self.finish_listeners {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for NetSocketData {
    fn clear_edges(&mut self) {
        self.stream = None;
        self.pending_connect = None;
        self.connect_rx = None;
        self.tls = None;
        self.server = None;
        self.destroyed = true;
        self.writable = false;
        self.flowing = false;
        self.encoding_utf8 = false;
        self.read_ended = true;
        self.end_requested = true;
        self.write_queue.clear();
        self.write_offset = 0;
        self.bytes_written = 0;
        self.finish_listeners.clear();
        self.data_listeners.clear();
        self.end_listeners.clear();
        self.close_listeners.clear();
        self.connect_listeners.clear();
        self.error_listeners.clear();
    }
}

pub type JsNetSocket = Gc<NetSocketData>;

pub struct NetServerData {
    listener: Option<std::net::TcpListener>,
    port: u16,
    closing: bool,
    connections: usize,
    listening_listeners: Vec<NetVoidListener>,
    close_listeners: Vec<NetVoidListener>,
    connection_listeners: Vec<NetConnectionListener>,
    close_override: Option<(Rc<dyn Fn()>, NetTrace)>,
    http: Option<HttpServerState>,
    tls_config: Option<Arc<rustls::ServerConfig>>,
}

impl Trace for NetServerData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for listener in &self.listening_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.close_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.connection_listeners {
            (listener.trace)(tracer);
        }
        if let Some((_, trace)) = &self.close_override {
            trace(tracer);
        }
        if let Some(http) = &self.http {
            http.trace(tracer);
        }
    }
}

impl ClearEdges for NetServerData {
    fn clear_edges(&mut self) {
        self.listener = None;
        self.closing = false;
        self.connections = 0;
        self.listening_listeners.clear();
        self.close_listeners.clear();
        self.connection_listeners.clear();
        self.close_override = None;
        self.http = None;
        self.tls_config = None;
    }
}

pub type JsNetServer = Gc<NetServerData>;

enum NetTask {
    Listening(JsNetServer),
    Close(JsNetServer),
    SocketConnect(JsNetSocket),
    SocketError(JsNetSocket, JsError),
    SocketEnd(JsNetSocket),
    SocketClose(JsNetSocket),
    Callback(NetVoidListener),
}

thread_local! {
    static NET_SERVERS: RefCell<Vec<JsNetServer>> = const { RefCell::new(Vec::new()) };
    static NET_SOCKETS: RefCell<Vec<JsNetSocket>> = const { RefCell::new(Vec::new()) };
    static NET_TASKS: RefCell<VecDeque<NetTask>> = const { RefCell::new(VecDeque::new()) };
}

fn net_port(value: f64) -> u16 {
    if value.is_finite() && value.fract() == 0.0 && (0.0..=65_535.0).contains(&value) {
        value as u16
    } else {
        throw_range_error_code(
            format!("options.port should be >= 0 and < 65536. Received type number ({value})."),
            "ERR_SOCKET_BAD_PORT",
        )
    }
}

fn net_socket_new(stream: std::net::TcpStream, server: Option<JsNetServer>) -> JsNetSocket {
    stream
        .set_nonblocking(true)
        .unwrap_or_else(|error| throw_error(format!("connect {}", fs_error_code(&error))));
    let socket = Gc::new(NetSocketData {
        stream: Some(stream),
        pending_connect: None,
        connect_rx: None,
        tls: None,
        server,
        destroyed: false,
        writable: true,
        flowing: false,
        encoding_utf8: false,
        read_ended: false,
        end_requested: false,
        close_emitted: false,
        bytes_written: 0,
        write_queue: VecDeque::new(),
        write_offset: 0,
        finish_listeners: Vec::new(),
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connect_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    NET_SOCKETS.with(|sockets| sockets.borrow_mut().push(socket.clone()));
    socket
}

pub fn net_server_new() -> JsNetServer {
    Gc::new(NetServerData {
        listener: None,
        port: 0,
        closing: false,
        connections: 0,
        listening_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connection_listeners: Vec::new(),
        close_override: None,
        http: None,
        tls_config: None,
    })
}

pub fn net_server_new_callback(
    callback: Rc<dyn Fn(JsNetSocket)>,
    trace: NetTrace,
) -> JsNetServer {
    let server = net_server_new();
    net_server_on_connection(&server, callback, trace, false);
    server
}

pub fn net_server_on_connection(
    server: &JsNetServer,
    callback: Rc<dyn Fn(JsNetSocket)>,
    trace: NetTrace,
    once: bool,
) {
    server.with_mut(|server| {
        server.connection_listeners.push(NetConnectionListener {
            invoke: callback,
            trace,
            once,
        });
    });
}

pub fn net_server_on_listening(
    server: &JsNetServer,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
) {
    server.with_mut(|server| {
        server.listening_listeners.push(NetVoidListener {
            invoke: callback,
            trace,
            once,
        });
    });
}

pub fn net_server_on_close(
    server: &JsNetServer,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
) {
    server.with_mut(|server| {
        server.close_listeners.push(NetVoidListener {
            invoke: callback,
            trace,
            once,
        });
    });
}

fn net_server_register(server: &JsNetServer) {
    NET_SERVERS.with(|servers| {
        let mut servers = servers.borrow_mut();
        if !servers.iter().any(|candidate| candidate.ptr_eq(server)) {
            servers.push(server.clone());
        }
    });
}

fn net_server_listen_host(
    server: &JsNetServer,
    port: f64,
    host: &str,
    ipv6_only: bool,
    reuse_port: bool,
) {
    let port = net_port(port);
    let listener = if host.is_empty() {
        net_listener("::", port, ipv6_only, reuse_port)
            .or_else(|_| net_listener("0.0.0.0", port, ipv6_only, reuse_port))
    } else {
        net_listener(host, port, ipv6_only, reuse_port)
    }
    .unwrap_or_else(|error| throw_error(format!("listen {}", fs_error_code(&error))));
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|error| throw_error(format!("listen {}", fs_error_code(&error))));
    let actual_port = listener
        .local_addr()
        .expect("scriptc: bound TCP listener without an address")
        .port();
    server.with_mut(|server| {
        server.listener = Some(listener);
        server.port = actual_port;
        server.closing = false;
    });
    net_server_register(server);
    NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::Listening(server.clone())));
}

pub fn net_server_listen(server: &JsNetServer, port: f64) {
    net_server_listen_host(server, port, "127.0.0.1", false, false);
}

pub fn net_server_listen_options(
    server: &JsNetServer,
    port: f64,
    host: &JsString,
    ipv6_only: bool,
) {
    net_server_listen_host(server, port, host, ipv6_only, false);
}

pub fn net_server_listen_options_reuse_port(
    server: &JsNetServer,
    port: f64,
    host: &JsString,
    ipv6_only: bool,
    reuse_port: bool,
) {
    net_server_listen_host(server, port, host, ipv6_only, reuse_port);
}

pub fn net_server_listen_callback(
    server: &JsNetServer,
    port: f64,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    net_server_on_listening(server, callback, trace, true);
    net_server_listen(server, port);
}

pub fn net_server_listen_options_callback(
    server: &JsNetServer,
    port: f64,
    host: &JsString,
    exclusive: bool,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    net_server_on_listening(server, callback, trace, true);
    net_server_listen_options(server, port, host, exclusive);
}

pub fn net_server_listen_options_reuse_port_callback(
    server: &JsNetServer,
    port: f64,
    host: &JsString,
    ipv6_only: bool,
    reuse_port: bool,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    net_server_on_listening(server, callback, trace, true);
    net_server_listen_options_reuse_port(server, port, host, ipv6_only, reuse_port);
}

pub fn net_server_port(server: &JsNetServer) -> f64 {
    server.with(|server| f64::from(server.port))
}

fn net_server_local_address(server: &JsNetServer) -> Option<std::net::SocketAddr> {
    server.with(|server| {
        server
            .listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok())
    })
}

pub fn net_server_address_ip(server: &JsNetServer) -> JsString {
    string(&net_server_local_address(server).map_or_else(|| "0.0.0.0".to_owned(), |address| address.ip().to_string()))
}

pub fn net_server_address_family(server: &JsNetServer) -> JsString {
    string(if net_server_local_address(server).is_some_and(|address| address.is_ipv6()) { "IPv6" } else { "IPv4" })
}

pub fn net_server_set_close_override(
    server: &JsNetServer,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    server.with_mut(|server| server.close_override = Some((callback, trace)));
}

pub fn net_server_close_direct(server: &JsNetServer) {
    let schedule = server.with_mut(|server| {
        if server.listener.take().is_none() || server.closing {
            return false;
        }
        server.closing = true;
        server.connections == 0
    });
    if schedule {
        NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::Close(server.clone())));
    }
}

pub fn net_server_close_direct_callback(
    server: &JsNetServer,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) {
    net_server_on_close(server, callback, trace, true);
    net_server_close_direct(server);
}

pub fn net_server_close(server: &JsNetServer) {
    let override_ = server.with(|server| server.close_override.as_ref().map(|value| value.0.clone()));
    if let Some(override_) = override_ {
        override_();
    } else {
        net_server_close_direct(server);
    }
}

pub fn net_socket_connect_deferred(port: f64, host: &JsString) -> JsNetSocket {
    let port = net_port(port);
    let host = host.to_string();
    let socket = Gc::new(NetSocketData {
        stream: None,
        pending_connect: Some((host, port)),
        connect_rx: None,
        tls: None,
        server: None,
        destroyed: false,
        writable: true,
        flowing: false,
        encoding_utf8: false,
        read_ended: false,
        end_requested: false,
        close_emitted: false,
        bytes_written: 0,
        write_queue: VecDeque::new(),
        write_offset: 0,
        finish_listeners: Vec::new(),
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connect_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    NET_SOCKETS.with(|sockets| sockets.borrow_mut().push(socket.clone()));
    socket
}

pub fn net_socket_start_connect(socket: &JsNetSocket) {
    let endpoint = socket.with_mut(|socket| {
        if socket.destroyed || socket.connect_rx.is_some() || socket.stream.is_some() {
            None
        } else {
            socket.pending_connect.take()
        }
    });
    let Some((host, port)) = endpoint else {
        return;
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::net::TcpStream::connect((host.as_str(), port))
            .map_err(|error| format!("connect {} {host}:{port}", fs_error_code(&error)));
        let _ = sender.send(result);
    });
    socket.with_mut(|socket| socket.connect_rx = Some(receiver));
}

pub fn net_socket_connect(port: f64, host: &JsString) -> JsNetSocket {
    let socket = net_socket_connect_deferred(port, host);
    net_socket_start_connect(&socket);
    socket
}

pub fn net_socket_connect_callback(
    port: f64,
    host: &JsString,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) -> JsNetSocket {
    let socket = net_socket_connect(port, host);
    net_socket_on_connect(&socket, callback, trace, true);
    socket
}

pub fn net_socket_on_data(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn(JsBytes<u8>, bool)>,
    trace: NetTrace,
    once: bool,
) {
    socket.with_mut(|socket| {
        if !socket.destroyed && !socket.read_ended {
            socket.flowing = true;
            socket.data_listeners.push(NetDataListener {
                invoke: callback,
                trace,
                once,
            });
        }
    });
}

pub fn net_socket_set_encoding(socket: &JsNetSocket, encoding: &JsString) {
    match encoding.as_ref() {
        "utf8" | "utf-8" => socket.with_mut(|socket| socket.encoding_utf8 = true),
        "ascii" | "latin1" | "binary" | "base64" | "base64url" | "hex" | "ucs2"
        | "ucs-2" | "utf16le" | "utf-16le" => throw_error(format!(
            "setEncoding('{encoding}') is not supported yet (only 'utf8' here)"
        )),
        _ => throw_type_error_code(format!("Unknown encoding: {encoding}"), "ERR_UNKNOWN_ENCODING"),
    }
}

fn net_socket_on_void(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
    select: impl FnOnce(&mut NetSocketData) -> &mut Vec<NetVoidListener>,
) {
    socket.with_mut(|socket| {
        if !socket.destroyed {
            select(socket).push(NetVoidListener {
                invoke: callback,
                trace,
                once,
            });
        }
    });
}

pub fn net_socket_on_end(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
) {
    net_socket_on_void(socket, callback, trace, once, |socket| {
        &mut socket.end_listeners
    });
}

pub fn net_socket_on_close(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
) {
    net_socket_on_void(socket, callback, trace, once, |socket| {
        &mut socket.close_listeners
    });
}

pub fn net_socket_on_connect(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
) {
    net_socket_on_void(socket, callback, trace, once, |socket| {
        &mut socket.connect_listeners
    });
}

pub fn net_socket_on_error(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn(JsError)>,
    trace: NetTrace,
    once: bool,
) {
    socket.with_mut(|socket| {
        if !socket.destroyed {
            socket.error_listeners.push(NetErrorListener {
                invoke: callback,
                trace,
                once,
            });
        }
    });
}

fn net_socket_queue(socket: &JsNetSocket, bytes: Vec<u8>) {
    socket.with_mut(|socket| {
        if !socket.destroyed && socket.writable && !socket.end_requested && !bytes.is_empty() {
            socket.bytes_written += bytes.len();
            socket.write_queue.push_back(NetWrite {
                bytes,
                callback: None,
            });
        }
    });
}

pub fn net_socket_after_write(socket: &JsNetSocket, callback: Rc<dyn Fn()>, trace: NetTrace) {
    let listener = NetVoidListener {
        invoke: callback,
        trace,
        once: true,
    };
    let pending = socket.with_mut(|socket| {
        if let Some(write) = socket.write_queue.back_mut() {
            write.callback = Some(listener.clone());
            false
        } else {
            true
        }
    });
    if pending {
        NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::Callback(listener)));
    }
}

pub fn net_socket_on_finish(socket: &JsNetSocket, callback: Rc<dyn Fn()>, trace: NetTrace) {
    socket.with_mut(|socket| {
        socket.finish_listeners.push(NetVoidListener {
            invoke: callback,
            trace,
            once: true,
        });
    });
}

pub fn net_socket_write_str(socket: &JsNetSocket, value: &JsString) {
    net_socket_queue(socket, value.as_bytes().to_vec());
}

pub fn net_socket_write_bytes(socket: &JsNetSocket, value: &JsBytes<u8>) {
    net_socket_queue(socket, bytes_u8_values(value));
}

pub fn net_socket_end(socket: &JsNetSocket) {
    socket.with_mut(|socket| {
        if !socket.destroyed && socket.writable {
            socket.end_requested = true;
            if socket.data_listeners.is_empty() {
                socket.flowing = true;
            }
        }
    });
}

pub fn net_socket_end_str(socket: &JsNetSocket, value: &JsString) {
    net_socket_write_str(socket, value);
    net_socket_end(socket);
}

pub fn net_socket_end_bytes(socket: &JsNetSocket, value: &JsBytes<u8>) {
    net_socket_write_bytes(socket, value);
    net_socket_end(socket);
}

pub fn net_socket_destroyed(socket: &JsNetSocket) -> bool {
    socket.with(|socket| socket.destroyed)
}

pub fn net_socket_writable(socket: &JsNetSocket) -> bool {
    socket.with(|socket| socket.writable && !socket.destroyed)
}

pub fn net_socket_readable(socket: &JsNetSocket) -> bool {
    socket.with(|socket| !socket.read_ended && !socket.destroyed)
}

pub fn net_socket_bytes_written(socket: &JsNetSocket) -> f64 {
    socket.with(|socket| socket.bytes_written as f64)
}

pub fn net_socket_remote_address(socket: &JsNetSocket) -> Option<JsString> {
    socket.with(|socket| {
        socket
            .stream
            .as_ref()
            .and_then(|stream| stream.peer_addr().ok())
            .map(|address| string(&address.ip().to_string()))
    })
}

pub fn net_socket_pause(socket: &JsNetSocket) -> JsNetSocket {
    socket.with_mut(|socket| socket.flowing = false);
    socket.clone()
}

pub fn net_socket_resume(socket: &JsNetSocket) -> JsNetSocket {
    socket.with_mut(|socket| {
        if !socket.destroyed && !socket.read_ended {
            socket.flowing = true;
        }
    });
    socket.clone()
}

pub fn net_socket_set_no_delay(socket: &JsNetSocket, enabled: bool) -> JsNetSocket {
    socket.with(|socket| {
        if let Some(stream) = &socket.stream {
            let _ = stream.set_nodelay(enabled);
        }
    });
    socket.clone()
}

pub fn net_socket_destroy_soon(socket: &JsNetSocket) {
    net_socket_end(socket);
}

pub fn net_socket_destroy(socket: &JsNetSocket) {
    let (schedule, server) = socket.with_mut(|socket| {
        if socket.destroyed {
            return (false, None);
        }
        if let Some(stream) = socket.stream.take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        socket.connect_rx = None;
        socket.pending_connect = None;
        socket.tls = None;
        socket.destroyed = true;
        socket.writable = false;
        socket.write_queue.clear();
        socket.write_offset = 0;
        (!socket.close_emitted, socket.server.take())
    });
    NET_SOCKETS.with(|sockets| sockets.borrow_mut().retain(|candidate| !candidate.ptr_eq(socket)));
    if let Some(server) = server {
        net_server_connection_closed(&server);
    }
    if schedule {
        NET_TASKS.with(|tasks| {
            tasks
                .borrow_mut()
                .push_back(NetTask::SocketClose(socket.clone()))
        });
    }
}

fn net_dispatch_listeners(listeners: &mut Vec<NetVoidListener>) -> Vec<NetVoidListener> {
    let snapshot = listeners.clone();
    listeners.retain(|listener| !listener.once);
    snapshot
}

fn net_server_connection_closed(server: &JsNetServer) {
    let schedule = server.with_mut(|server| {
        server.connections = server.connections.saturating_sub(1);
        server.closing && server.connections == 0
    });
    if schedule {
        NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::Close(server.clone())));
    }
}

fn net_dispatch_task(task: NetTask) {
    match task {
        NetTask::Listening(server) => {
            let listeners = server.with_mut(|server| {
                if server.listener.is_none() {
                    return Vec::new();
                }
                net_dispatch_listeners(&mut server.listening_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }
        NetTask::Close(server) => {
            NET_SERVERS.with(|servers| {
                servers.borrow_mut().retain(|candidate| !candidate.ptr_eq(&server));
            });
            let listeners = server.with_mut(|server| {
                server.closing = false;
                net_dispatch_listeners(&mut server.close_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }
        NetTask::SocketConnect(socket) => {
            let listeners = socket.with_mut(|socket| {
                net_dispatch_listeners(&mut socket.connect_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }
        NetTask::SocketError(socket, error) => {
            let listeners = socket.with_mut(|socket| {
                let listeners = socket.error_listeners.clone();
                socket.error_listeners.retain(|listener| !listener.once);
                listeners
            });
            if listeners.is_empty() {
                throw_value(error);
            }
            for listener in listeners {
                (listener.invoke)(error.clone());
            }
            net_socket_destroy(&socket);
        }
        NetTask::SocketEnd(socket) => {
            let (listeners, should_close) = socket.with_mut(|socket| {
                socket.data_listeners.clear();
                (
                    std::mem::take(&mut socket.end_listeners),
                    !socket.writable,
                )
            });
            for listener in listeners {
                (listener.invoke)();
            }
            if should_close {
                net_socket_destroy(&socket);
            }
        }
        NetTask::SocketClose(socket) => {
            let listeners = socket.with_mut(|socket| {
                if socket.close_emitted {
                    return Vec::new();
                }
                socket.close_emitted = true;
                socket.destroyed = true;
                socket.writable = false;
                socket.stream = None;
                socket.tls = None;
                socket.write_queue.clear();
                socket.finish_listeners.clear();
                socket.data_listeners.clear();
                socket.end_listeners.clear();
                socket.connect_listeners.clear();
                socket.error_listeners.clear();
                std::mem::take(&mut socket.close_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }
        NetTask::Callback(listener) => (listener.invoke)(),
    }
}

fn net_accept_one() -> bool {
    let accepted = NET_SERVERS.with(|servers| {
        servers.borrow().iter().find_map(|candidate| {
            candidate.with(|server| {
                let listener = server.listener.as_ref()?;
                match listener.accept() {
                    Ok((stream, _)) => Some((candidate.clone(), stream)),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
                    Err(_) => None,
                }
            })
        })
    });
    let Some((server, stream)) = accepted else {
        return false;
    };
    let listeners = server.with_mut(|server| {
        let snapshot = server.connection_listeners.clone();
        server.connection_listeners.retain(|listener| !listener.once);
        snapshot
    });
    server.with_mut(|server| server.connections += 1);
    let socket = net_socket_new(stream, Some(server.clone()));
    if tls_server_accept(&server, &socket) {
        return true;
    }
    if server.with(|server| server.http.is_some()) {
        http_server_accept(&server, &socket);
    }
    for listener in listeners {
        (listener.invoke)(socket.clone());
    }
    true
}

fn net_socket_connect_one() -> bool {
    let task = NET_SOCKETS.with(|sockets| {
        sockets.borrow().iter().find_map(|candidate| {
            candidate.with_mut(|socket| {
                let result = socket.connect_rx.as_ref()?.try_recv();
                match result {
                    Ok(Ok(stream)) => {
                        socket.connect_rx = None;
                        match stream.set_nonblocking(true) {
                            Ok(()) => {
                                socket.stream = Some(stream);
                                if socket.tls.is_some() {
                                    None
                                } else {
                                    Some(NetTask::SocketConnect(candidate.clone()))
                                }
                            }
                            Err(error) => Some(NetTask::SocketError(
                                candidate.clone(),
                                error_new("Error", string(&format!("connect {}", fs_error_code(&error)))),
                            )),
                        }
                    }
                    Ok(Err(message)) => {
                        socket.connect_rx = None;
                        Some(NetTask::SocketError(
                            candidate.clone(),
                            error_new("Error", string(&message)),
                        ))
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => None,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        socket.connect_rx = None;
                        Some(NetTask::SocketError(
                            candidate.clone(),
                            error_new("Error", string("connect worker stopped")),
                        ))
                    }
                }
            })
        })
    });
    let Some(task) = task else {
        return false;
    };
    NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(task));
    true
}

fn net_socket_flush_one() -> bool {
    enum Flush {
        Idle,
        Progress(Option<NetVoidListener>),
        Finish(Vec<NetVoidListener>),
        Close(JsNetSocket, Vec<NetVoidListener>),
    }

    let outcome = NET_SOCKETS.with(|sockets| {
        sockets.borrow().iter().find_map(|candidate| {
            let outcome = candidate.with_mut(|socket| {
                if socket.destroyed || !socket.writable {
                    return Flush::Idle;
                }
                if socket.pending_connect.is_some() || socket.connect_rx.is_some() {
                    return Flush::Idle;
                }
                if socket.tls.is_some() {
                    return Flush::Idle;
                }
                if let Some(write) = socket.write_queue.front() {
                    let Some(stream) = socket.stream.as_mut() else {
                        return Flush::Close(candidate.clone(), Vec::new());
                    };
                    match std::io::Write::write(stream, &write.bytes[socket.write_offset..]) {
                        Ok(0) => Flush::Idle,
                        Ok(length) => {
                            socket.write_offset += length;
                            let callback = if socket.write_offset == write.bytes.len() {
                                socket.write_offset = 0;
                                socket.write_queue.pop_front().and_then(|write| write.callback)
                            } else {
                                None
                            };
                            Flush::Progress(callback)
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Flush::Idle,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                            Flush::Progress(None)
                        }
                        Err(_) => Flush::Close(candidate.clone(), Vec::new()),
                    }
                } else if socket.end_requested {
                    if let Some(stream) = socket.stream.as_ref() {
                        let _ = stream.shutdown(std::net::Shutdown::Write);
                    }
                    socket.writable = false;
                    if socket.read_ended {
                        Flush::Close(
                            candidate.clone(),
                            std::mem::take(&mut socket.finish_listeners),
                        )
                    } else {
                        Flush::Finish(std::mem::take(&mut socket.finish_listeners))
                    }
                } else {
                    Flush::Idle
                }
            });
            match outcome {
                Flush::Idle => None,
                other => Some(other),
            }
        })
    });
    match outcome {
        Some(Flush::Progress(callback)) => {
            if let Some(callback) = callback {
                NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::Callback(callback)));
            }
            true
        }
        Some(Flush::Finish(callbacks)) => {
            NET_TASKS.with(|tasks| {
                tasks
                    .borrow_mut()
                    .extend(callbacks.into_iter().map(NetTask::Callback));
            });
            true
        }
        Some(Flush::Close(socket, callbacks)) => {
            NET_TASKS.with(|tasks| {
                tasks
                    .borrow_mut()
                    .extend(callbacks.into_iter().map(NetTask::Callback));
            });
            net_socket_destroy(&socket);
            true
        }
        Some(Flush::Idle) | None => false,
    }
}

fn net_socket_read_one() -> bool {
    enum ReadEvent {
        Data(JsNetSocket, Vec<u8>),
        End(JsNetSocket),
        Close(JsNetSocket),
    }

    let event = NET_SOCKETS.with(|sockets| {
        sockets.borrow().iter().find_map(|candidate| {
            candidate.with_mut(|socket| {
                if socket.destroyed || socket.read_ended {
                    return None;
                }
                if socket.pending_connect.is_some() || socket.connect_rx.is_some() {
                    return None;
                }
                if socket.tls.is_some() {
                    return None;
                }
                let Some(stream) = socket.stream.as_mut() else {
                    return Some(ReadEvent::Close(candidate.clone()));
                };
                if !socket.flowing {
                    if !socket.end_requested {
                        return None;
                    }
                    let mut probe = [0_u8; 1];
                    return match stream.peek(&mut probe) {
                        Ok(0) => {
                            socket.read_ended = true;
                            Some(ReadEvent::End(candidate.clone()))
                        }
                        Ok(_) => None,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => None,
                        Err(_) => Some(ReadEvent::Close(candidate.clone())),
                    };
                }
                let mut buffer = vec![0_u8; 65_536];
                match std::io::Read::read(stream, &mut buffer) {
                    Ok(0) => {
                        socket.read_ended = true;
                        socket.end_requested = true;
                        Some(ReadEvent::End(candidate.clone()))
                    }
                    Ok(length) => {
                        buffer.truncate(length);
                        Some(ReadEvent::Data(candidate.clone(), buffer))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => None,
                    Err(_) => Some(ReadEvent::Close(candidate.clone())),
                }
            })
        })
    });
    match event {
        Some(ReadEvent::Data(socket, bytes)) => {
            let (listeners, encoding_utf8) = socket.with_mut(|socket| {
                let snapshot = socket.data_listeners.clone();
                socket.data_listeners.retain(|listener| !listener.once);
                (snapshot, socket.encoding_utf8)
            });
            let chunk = bytes_from_elements(bytes);
            for listener in listeners {
                (listener.invoke)(chunk.clone(), encoding_utf8);
            }
            true
        }
        Some(ReadEvent::End(socket)) => {
            NET_TASKS.with(|tasks| {
                tasks
                    .borrow_mut()
                    .push_back(NetTask::SocketEnd(socket.clone()))
            });
            true
        }
        Some(ReadEvent::Close(socket)) => {
            net_socket_destroy(&socket);
            true
        }
        None => false,
    }
}

fn net_dispatch_one() -> bool {
    if let Some(task) = NET_TASKS.with(|tasks| tasks.borrow_mut().pop_front()) {
        net_dispatch_task(task);
        return true;
    }
    http_tls_dispatch_one()
        || net_accept_one()
        || net_socket_connect_one()
        || tls_socket_dispatch_one()
        || net_socket_flush_one()
        || net_socket_read_one()
}

fn net_finish() {
    http_tls_finish();
    NET_TASKS.with(|tasks| tasks.borrow_mut().clear());
    let servers = NET_SERVERS.with(|servers| std::mem::take(&mut *servers.borrow_mut()));
    for server in servers {
        server.with_mut(ClearEdges::clear_edges);
    }
    let sockets = NET_SOCKETS.with(|sockets| std::mem::take(&mut *sockets.borrow_mut()));
    for socket in sockets {
        socket.with_mut(ClearEdges::clear_edges);
    }
}
