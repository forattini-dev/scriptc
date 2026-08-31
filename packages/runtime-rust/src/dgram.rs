#[derive(Clone)]
struct DgramVoidListener {
    invoke: Rc<dyn Fn()>,
    trace: DgramTrace,
    once: bool,
}

#[derive(Clone)]
struct DgramErrorListener {
    invoke: Rc<dyn Fn(JsError)>,
    trace: DgramTrace,
    once: bool,
}

#[derive(Clone)]
struct DgramMessageListener {
    invoke: DgramMessageCallback,
    trace: DgramTrace,
    once: bool,
}

pub type DgramTrace = Rc<dyn Fn(&mut Tracer<'_>)>;
pub type DgramMessageCallback = Rc<dyn Fn(JsBytes<u8>, JsString, JsString, f64, f64)>;

pub struct DgramSocketData {
    socket: Option<std::net::UdpSocket>,
    _reuse_addr: bool,
    bound: bool,
    connected: bool,
    closing: bool,
    close_emitted: bool,
    unrefed: bool,
    emit_listening: bool,
    emit_connect: bool,
    pending_error: Option<JsError>,
    message_listeners: Vec<DgramMessageListener>,
    error_listeners: Vec<DgramErrorListener>,
    listening_listeners: Vec<DgramVoidListener>,
    close_listeners: Vec<DgramVoidListener>,
    connect_listeners: Vec<DgramVoidListener>,
}

impl Trace for DgramSocketData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for listener in &self.message_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.error_listeners {
            (listener.trace)(tracer);
        }
        for listeners in [
            &self.listening_listeners,
            &self.close_listeners,
            &self.connect_listeners,
        ] {
            for listener in listeners {
                (listener.trace)(tracer);
            }
        }
    }
}

impl ClearEdges for DgramSocketData {
    fn clear_edges(&mut self) {
        self.socket = None;
        self.bound = false;
        self.connected = false;
        self.closing = false;
        self.close_emitted = true;
        self.pending_error = None;
        self.message_listeners.clear();
        self.error_listeners.clear();
        self.listening_listeners.clear();
        self.close_listeners.clear();
        self.connect_listeners.clear();
    }
}

pub type JsDgramSocket = Gc<DgramSocketData>;

thread_local! {
    static DGRAM_SOCKETS: RefCell<Vec<JsDgramSocket>> = const { RefCell::new(Vec::new()) };
}

fn dgram_register(socket: &JsDgramSocket) {
    DGRAM_SOCKETS.with(|sockets| {
        let mut sockets = sockets.borrow_mut();
        if !sockets.iter().any(|candidate| candidate.ptr_eq(socket)) {
            sockets.push(socket.clone());
        }
    });
}

fn dgram_unregister(socket: &JsDgramSocket) {
    DGRAM_SOCKETS.with(|sockets| sockets.borrow_mut().retain(|candidate| !candidate.ptr_eq(socket)));
}

fn dgram_state_error(message: &str) -> ! {
    let code = match message {
        "Already connected" => "ERR_SOCKET_DGRAM_IS_CONNECTED",
        "Not running" => "ERR_SOCKET_DGRAM_NOT_RUNNING",
        "Socket is already bound" => "ERR_SOCKET_ALREADY_BOUND",
        _ => throw_error(message.to_owned()),
    };
    throw_error_code(message.to_owned(), code)
}

fn dgram_port(port: f64) -> u16 {
    if port.is_finite() && port.fract() == 0.0 && (0.0..65_536.0).contains(&port) {
        port as u16
    } else {
        throw_range_error_code(
            format!(
                "Port should be > 0 and < 65536. Received type number ({}).",
                format_number(port)
            ),
            "ERR_SOCKET_BAD_PORT",
        )
    }
}

fn dgram_ipv4(host: &JsString, port: u16, bind: bool) -> Result<std::net::SocketAddr, String> {
    let address = if host.is_empty() && bind {
        std::net::Ipv4Addr::UNSPECIFIED
    } else if host.as_ref() == "localhost" {
        std::net::Ipv4Addr::LOCALHOST
    } else {
        host.parse::<std::net::Ipv4Addr>()
            .map_err(|_| format!("getaddrinfo ENOTFOUND {host}"))?
    };
    Ok(std::net::SocketAddr::V4(std::net::SocketAddrV4::new(address, port)))
}

fn dgram_error(operation: &str, address: std::net::SocketAddr, error: &std::io::Error) -> JsError {
    error_new(
        "Error",
        string(&format!("{operation} {} {address}", fs_error_code(error))),
    )
}

fn dgram_defer_error(socket: &JsDgramSocket, message: String) {
    socket.with_mut(|state| {
        if state.pending_error.is_none() {
            state.pending_error = Some(error_new("Error", string(&message)));
        }
    });
    dgram_register(socket);
}

fn dgram_nonblocking(socket: std::net::UdpSocket) -> std::net::UdpSocket {
    socket
        .set_nonblocking(true)
        .unwrap_or_else(|error| throw_error(format!("udp nonblocking: {error}")));
    socket
}

fn dgram_open_ephemeral() -> std::net::UdpSocket {
    dgram_nonblocking(
        std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
            .unwrap_or_else(|error| throw_error(format!("udp bind: {error}"))),
    )
}

pub fn dgram_create_socket(reuse_addr: bool) -> JsDgramSocket {
    Gc::new(DgramSocketData {
        socket: None,
        _reuse_addr: reuse_addr,
        bound: false,
        connected: false,
        closing: false,
        close_emitted: false,
        unrefed: false,
        emit_listening: false,
        emit_connect: false,
        pending_error: None,
        message_listeners: Vec::new(),
        error_listeners: Vec::new(),
        listening_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connect_listeners: Vec::new(),
    })
}

pub fn dgram_bind(socket: &JsDgramSocket, port: f64, host: &JsString) {
    let (closing, bound) = socket.with(|state| (state.closing || state.close_emitted, state.bound));
    if closing {
        dgram_state_error("Not running");
    }
    if bound {
        dgram_state_error("Socket is already bound");
    }
    let address = match dgram_ipv4(host, dgram_port(port), true) {
        Ok(address) => address,
        Err(message) => return dgram_defer_error(socket, message),
    };
    match std::net::UdpSocket::bind(address) {
        Ok(udp) => {
            let udp = dgram_nonblocking(udp);
            socket.with_mut(|state| {
                state.socket = Some(udp);
                state.bound = true;
                state.emit_listening = true;
            });
            dgram_register(socket);
        }
        Err(error) => dgram_defer_error(
            socket,
            format!("bind {} {address}", fs_error_code(&error)),
        ),
    }
}

pub fn dgram_bind_callback(
    socket: &JsDgramSocket,
    port: f64,
    host: &JsString,
    callback: Rc<dyn Fn()>,
    trace: DgramTrace,
) {
    dgram_on_listening(socket, callback, trace, true);
    dgram_bind(socket, port, host);
}

pub fn dgram_connect(socket: &JsDgramSocket, port: f64, host: &JsString) {
    let (closing, connected) =
        socket.with(|state| (state.closing || state.close_emitted, state.connected));
    if closing {
        dgram_state_error("Not running");
    }
    if connected {
        dgram_state_error("Already connected");
    }
    let address = match dgram_ipv4(host, dgram_port(port), false) {
        Ok(address) => address,
        Err(message) => return dgram_defer_error(socket, message),
    };
    let had_socket = socket.with(|state| state.socket.is_some());
    if !had_socket {
        let udp = dgram_open_ephemeral();
        socket.with_mut(|state| {
            state.socket = Some(udp);
            state.bound = true;
            state.emit_listening = true;
        });
    }
    let result = socket.with(|state| {
        state
            .socket
            .as_ref()
            .expect("scriptc: dgram socket missing after bind")
            .connect(address)
    });
    match result {
        Ok(()) => socket.with_mut(|state| {
            state.connected = true;
            state.emit_connect = true;
        }),
        Err(error) => socket.with_mut(|state| {
            state.pending_error = Some(dgram_error("connect", address, &error));
        }),
    }
    dgram_register(socket);
}

pub fn dgram_connect_callback(
    socket: &JsDgramSocket,
    port: f64,
    host: &JsString,
    callback: Rc<dyn Fn()>,
    trace: DgramTrace,
) {
    dgram_on_connect(socket, callback, trace, true);
    dgram_connect(socket, port, host);
}

pub fn dgram_is_connected(socket: &JsDgramSocket) -> bool {
    socket.with(|state| state.connected)
}

pub fn dgram_send_values(
    socket: &JsDgramSocket,
    data: Vec<u8>,
    port: f64,
    host: &JsString,
) {
    let (closing, connected) =
        socket.with(|state| (state.closing || state.close_emitted, state.connected));
    if closing {
        dgram_state_error("Not running");
    }
    if connected {
        dgram_state_error("Already connected");
    }
    let address = match dgram_ipv4(host, dgram_port(port), false) {
        Ok(address) => address,
        Err(message) => return dgram_defer_error(socket, message),
    };
    if socket.with(|state| state.socket.is_none()) {
        let udp = dgram_open_ephemeral();
        socket.with_mut(|state| {
            state.socket = Some(udp);
            state.bound = true;
            state.emit_listening = true;
        });
    }
    let result = socket.with(|state| {
        state
            .socket
            .as_ref()
            .expect("scriptc: dgram socket missing before send")
            .send_to(&data, address)
    });
    if let Err(error) = result {
        socket.with_mut(|state| {
            state.pending_error = Some(dgram_error("send", address, &error));
        });
    }
    dgram_register(socket);
}

pub fn dgram_send_string(
    socket: &JsDgramSocket,
    data: &JsString,
    port: f64,
    host: &JsString,
) {
    dgram_send_values(socket, data.as_bytes().to_vec(), port, host);
}

pub fn dgram_send_bytes(
    socket: &JsDgramSocket,
    data: &JsBytes<u8>,
    port: f64,
    host: &JsString,
) {
    dgram_send_values(socket, bytes_u8_values(data), port, host);
}

pub fn dgram_send_string_slice(
    socket: &JsDgramSocket,
    data: &JsString,
    offset: usize,
    length: usize,
    port: f64,
    host: &JsString,
) {
    dgram_send_values(socket, data.as_bytes()[offset..offset + length].to_vec(), port, host);
}

pub fn dgram_send_bytes_slice(
    socket: &JsDgramSocket,
    data: &JsBytes<u8>,
    offset: usize,
    length: usize,
    port: f64,
    host: &JsString,
) {
    let values = bytes_u8_values(data);
    dgram_send_values(socket, values[offset..offset + length].to_vec(), port, host);
}

pub fn dgram_address(socket: &JsDgramSocket) -> (JsString, JsString, f64) {
    let address = socket.with(|state| {
        if !state.bound {
            dgram_state_error("Not running");
        }
        state
            .socket
            .as_ref()
            .and_then(|udp| udp.local_addr().ok())
            .unwrap_or_else(|| std::net::SocketAddr::from(([0, 0, 0, 0], 0)))
    });
    (string(&address.ip().to_string()), string("IPv4"), f64::from(address.port()))
}

pub fn dgram_close(socket: &JsDgramSocket) {
    if socket.with(|state| state.closing || state.close_emitted) {
        dgram_state_error("Not running");
    }
    socket.with_mut(|state| {
        state.socket = None;
        state.connected = false;
        state.closing = true;
    });
    dgram_unregister(socket);
    dgram_register(socket);
}

pub fn dgram_close_callback(
    socket: &JsDgramSocket,
    callback: Rc<dyn Fn()>,
    trace: DgramTrace,
) {
    dgram_on_close(socket, callback, trace, true);
    dgram_close(socket);
}

pub fn dgram_unref(socket: &JsDgramSocket) {
    socket.with_mut(|state| state.unrefed = true);
}

pub fn dgram_ref(socket: &JsDgramSocket) {
    socket.with_mut(|state| state.unrefed = false);
}

pub fn dgram_on_message(
    socket: &JsDgramSocket,
    callback: DgramMessageCallback,
    trace: DgramTrace,
    once: bool,
) {
    socket.with_mut(|state| {
        if !state.close_emitted {
            state.message_listeners.push(DgramMessageListener { invoke: callback, trace, once });
        }
    });
}

pub fn dgram_on_error(
    socket: &JsDgramSocket,
    callback: Rc<dyn Fn(JsError)>,
    trace: DgramTrace,
    once: bool,
) {
    socket.with_mut(|state| {
        if !state.close_emitted {
            state.error_listeners.push(DgramErrorListener { invoke: callback, trace, once });
        }
    });
}

fn dgram_on_void(
    socket: &JsDgramSocket,
    callback: Rc<dyn Fn()>,
    trace: DgramTrace,
    once: bool,
    select: impl FnOnce(&mut DgramSocketData) -> &mut Vec<DgramVoidListener>,
) {
    socket.with_mut(|state| {
        if !state.close_emitted {
            select(state).push(DgramVoidListener { invoke: callback, trace, once });
        }
    });
}

pub fn dgram_on_listening(socket: &JsDgramSocket, callback: Rc<dyn Fn()>, trace: DgramTrace, once: bool) {
    dgram_on_void(socket, callback, trace, once, |state| &mut state.listening_listeners);
}

pub fn dgram_on_close(socket: &JsDgramSocket, callback: Rc<dyn Fn()>, trace: DgramTrace, once: bool) {
    dgram_on_void(socket, callback, trace, once, |state| &mut state.close_listeners);
}

pub fn dgram_on_connect(socket: &JsDgramSocket, callback: Rc<dyn Fn()>, trace: DgramTrace, once: bool) {
    dgram_on_void(socket, callback, trace, once, |state| &mut state.connect_listeners);
}

fn dgram_void_snapshot(listeners: &mut Vec<DgramVoidListener>) -> Vec<DgramVoidListener> {
    let snapshot = listeners.clone();
    listeners.retain(|listener| !listener.once);
    snapshot
}

fn dgram_dispatch_flags(socket: &JsDgramSocket) -> bool {
    enum Event {
        Listening(Vec<DgramVoidListener>),
        Connect(Vec<DgramVoidListener>),
        Error(JsError, Vec<DgramErrorListener>),
        Close(Vec<DgramVoidListener>),
    }
    let event = socket.with_mut(|state| {
        if state.emit_listening {
            state.emit_listening = false;
            return Some(Event::Listening(dgram_void_snapshot(&mut state.listening_listeners)));
        }
        if state.emit_connect {
            state.emit_connect = false;
            return Some(Event::Connect(dgram_void_snapshot(&mut state.connect_listeners)));
        }
        if let Some(error) = state.pending_error.take() {
            let listeners = state.error_listeners.clone();
            state.error_listeners.retain(|listener| !listener.once);
            return Some(Event::Error(error, listeners));
        }
        if state.closing && !state.close_emitted {
            state.close_emitted = true;
            return Some(Event::Close(dgram_void_snapshot(&mut state.close_listeners)));
        }
        None
    });
    match event {
        Some(Event::Listening(listeners)) | Some(Event::Connect(listeners)) => {
            for listener in listeners {
                (listener.invoke)();
            }
        }
        Some(Event::Error(error, listeners)) => {
            if listeners.is_empty() {
                eprintln!("Unhandled 'error' event: Error: {}", error_message(&error));
                std::process::exit(1);
            }
            for listener in listeners {
                (listener.invoke)(error.clone());
            }
            let inert = socket.with(|state| {
                state.socket.is_none() && !state.bound && !state.closing && !state.close_emitted
            });
            if inert {
                socket.with_mut(ClearEdges::clear_edges);
                dgram_unregister(socket);
            }
        }
        Some(Event::Close(listeners)) => {
            for listener in listeners {
                (listener.invoke)();
            }
            socket.with_mut(ClearEdges::clear_edges);
            dgram_unregister(socket);
        }
        None => return false,
    }
    true
}

fn dgram_receive_one(socket: &JsDgramSocket) -> bool {
    let packet = socket.with_mut(|state| {
        if state.message_listeners.is_empty() {
            return None;
        }
        let udp = state.socket.as_ref()?;
        let mut bytes = vec![0_u8; 65_536];
        match udp.recv_from(&mut bytes) {
            Ok((length, from)) => {
                bytes.truncate(length);
                let listeners = state.message_listeners.clone();
                state.message_listeners.retain(|listener| !listener.once);
                Some((bytes, from, listeners))
            }
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => None,
            Err(_) => None,
        }
    });
    let Some((bytes, from, listeners)) = packet else {
        return false;
    };
    let length = bytes.len() as f64;
    let chunk = bytes_from_elements(bytes);
    let address = string(&from.ip().to_string());
    let family = string("IPv4");
    for listener in listeners {
        (listener.invoke)(chunk.clone(), address.clone(), family.clone(), f64::from(from.port()), length);
    }
    true
}

fn dgram_dispatch_one() -> bool {
    let sockets = DGRAM_SOCKETS.with(|sockets| sockets.borrow().clone());
    for socket in &sockets {
        if dgram_dispatch_flags(socket) {
            return true;
        }
    }
    for socket in &sockets {
        if dgram_receive_one(socket) {
            return true;
        }
    }
    false
}

fn dgram_finish() {
    let sockets = DGRAM_SOCKETS.with(|sockets| std::mem::take(&mut *sockets.borrow_mut()));
    for socket in sockets {
        socket.with_mut(ClearEdges::clear_edges);
    }
}
