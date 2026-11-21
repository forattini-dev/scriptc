thread_local! {
    static NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT: Cell<f64> = const { Cell::new(250.0) };
}

pub fn net_is_ipv4(value: &JsString) -> bool {
    value.as_ref().parse::<std::net::Ipv4Addr>().is_ok()
}

pub fn net_is_ipv6(value: &JsString) -> bool {
    value.as_ref().parse::<std::net::Ipv6Addr>().is_ok()
}

pub fn net_is_ip(value: &JsString) -> f64 {
    if net_is_ipv4(value) {
        4.0
    } else if net_is_ipv6(value) {
        6.0
    } else {
        0.0
    }
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

enum LocalStreamEvent {
    Data(Vec<u8>),
    End,
    Error(String),
}

#[cfg(unix)]
type LocalStreamWriter = std::os::unix::net::UnixStream;
#[cfg(windows)]
enum LocalStreamWriter {
    File(std::fs::File),
    Pipe(WindowsPipe),
}

#[cfg(windows)]
#[derive(Clone)]
struct WindowsPipe(std::sync::Arc<miow::pipe::NamedPipe>);

#[cfg(windows)]
impl std::io::Read for WindowsPipe {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        std::io::Read::read(&mut &*self.0, output)
    }
}

#[cfg(windows)]
impl std::io::Write for WindowsPipe {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        std::io::Write::write(&mut &*self.0, bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::Write::flush(&mut &*self.0)
    }
}

#[cfg(windows)]
impl std::io::Write for LocalStreamWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::File(file) => std::io::Write::write(file, bytes),
            Self::Pipe(pipe) => std::io::Write::write(pipe, bytes),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::File(file) => std::io::Write::flush(file),
            Self::Pipe(pipe) => std::io::Write::flush(pipe),
        }
    }
}

struct LocalStream {
    writer: LocalStreamWriter,
    events: std::sync::mpsc::Receiver<LocalStreamEvent>,
    buffered: VecDeque<u8>,
    ended: bool,
    error: Option<String>,
}

impl LocalStream {
    fn receive(&mut self) {
        if self.ended || self.error.is_some() || !self.buffered.is_empty() {
            return;
        }
        match self.events.try_recv() {
            Ok(LocalStreamEvent::Data(bytes)) => self.buffered.extend(bytes),
            Ok(LocalStreamEvent::End) => self.ended = true,
            Ok(LocalStreamEvent::Error(error)) => self.error = Some(error),
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
            Err(std::sync::mpsc::TryRecvError::Disconnected) => self.ended = true,
        }
    }

    fn peek(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.receive();
        if let Some(error) = &self.error {
            return Err(std::io::Error::other(error.clone()));
        }
        if self.buffered.is_empty() {
            return if self.ended {
                Ok(0)
            } else {
                Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
            };
        }
        let length = output.len().min(self.buffered.len());
        for (slot, value) in output.iter_mut().zip(self.buffered.iter()).take(length) {
            *slot = *value;
        }
        Ok(length)
    }

    fn shutdown(&mut self, direction: std::net::Shutdown) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            self.writer.shutdown(direction)
        }
        #[cfg(windows)]
        {
            let _ = direction;
            std::io::Write::flush(&mut self.writer)
        }
    }
}

impl std::io::Read for LocalStream {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.receive();
        if let Some(error) = self.error.take() {
            return Err(std::io::Error::other(error));
        }
        if self.buffered.is_empty() {
            return if self.ended {
                Ok(0)
            } else {
                Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
            };
        }
        let length = output.len().min(self.buffered.len());
        for slot in output.iter_mut().take(length) {
            *slot = self
                .buffered
                .pop_front()
                .expect("checked local socket buffer");
        }
        Ok(length)
    }
}

impl std::io::Write for LocalStream {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        std::io::Write::write(&mut self.writer, bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::Write::flush(&mut self.writer)
    }
}

enum NetStream {
    Tcp(std::net::TcpStream),
    Local(LocalStream),
}

struct LocalListener {
    accepted: std::sync::mpsc::Receiver<std::io::Result<NetStream>>,
    closed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    path: String,
}

impl LocalListener {
    fn accept(&self) -> std::io::Result<NetStream> {
        match self.accepted.try_recv() {
            Ok(result) => result,
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "local listener stopped",
            )),
        }
    }
}

impl Drop for LocalListener {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        self.closed.store(true, Ordering::Release);
        #[cfg(unix)]
        let _ = std::os::unix::net::UnixStream::connect(&self.path);
        #[cfg(windows)]
        let _ = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path);
    }
}

enum NetListener {
    Tcp(std::net::TcpListener),
    Local(LocalListener),
}

impl NetStream {
    fn set_nonblocking(&self, enabled: bool) -> std::io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.set_nonblocking(enabled),
            Self::Local(_) => Ok(()),
        }
    }

    fn shutdown(&mut self, direction: std::net::Shutdown) -> std::io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.shutdown(direction),
            Self::Local(stream) => stream.shutdown(direction),
        }
    }

    fn peek(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(stream) => stream.peek(output),
            Self::Local(stream) => stream.peek(output),
        }
    }

    fn peer_address(&self) -> Option<JsString> {
        match self {
            Self::Tcp(stream) => stream
                .peer_addr()
                .ok()
                .map(|address| string(&address.ip().to_string())),
            Self::Local(_) => None,
        }
    }

    fn set_no_delay(&self, enabled: bool) {
        if let Self::Tcp(stream) = self {
            let _ = stream.set_nodelay(enabled);
        }
    }
}

impl std::io::Read for NetStream {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(stream) => std::io::Read::read(stream, output),
            Self::Local(stream) => std::io::Read::read(stream, output),
        }
    }
}

impl std::io::Write for NetStream {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(stream) => std::io::Write::write(stream, bytes),
            Self::Local(stream) => std::io::Write::write(stream, bytes),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Tcp(stream) => std::io::Write::flush(stream),
            Self::Local(stream) => std::io::Write::flush(stream),
        }
    }
}

enum NetEndpoint {
    Tcp(String, u16),
    Local(String),
}

struct NetConnectError {
    code: &'static str,
    message: String,
}

pub struct NetSocketData {
    stream: Option<NetStream>,
    pending_connect: Option<NetEndpoint>,
    connect_rx: Option<std::sync::mpsc::Receiver<Result<NetStream, NetConnectError>>>,
    tls: Option<TlsSocketState>,
    server: Option<JsNetServer>,
    destroyed: bool,
    writable: bool,
    flowing: bool,
    encoding_utf8: bool,
    read_ended: bool,
    end_requested: bool,
    close_emitted: bool,
    had_error: bool,
    timeout_ms: Option<f64>,
    timeout_timer: Option<f64>,
    bytes_written: usize,
    write_queue: VecDeque<NetWrite>,
    write_offset: usize,
    finish_listeners: Vec<NetVoidListener>,
    data_listeners: Vec<NetDataListener>,
    end_listeners: Vec<NetVoidListener>,
    close_listeners: Vec<NetVoidListener>,
    connect_listeners: Vec<NetVoidListener>,
    secure_connect_listeners: Vec<NetVoidListener>,
    timeout_listeners: Vec<NetVoidListener>,
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
        for listener in &self.secure_connect_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.timeout_listeners {
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
        if let Some(timer) = self.timeout_timer.take() {
            timer_clear(timer);
        }
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
        self.had_error = false;
        self.write_queue.clear();
        self.write_offset = 0;
        self.bytes_written = 0;
        self.finish_listeners.clear();
        self.data_listeners.clear();
        self.end_listeners.clear();
        self.close_listeners.clear();
        self.connect_listeners.clear();
        self.secure_connect_listeners.clear();
        self.timeout_listeners.clear();
        self.error_listeners.clear();
    }
}

pub type JsNetSocket = Gc<NetSocketData>;

pub struct NetServerData {
    listener: Option<NetListener>,
    port: u16,
    closing: bool,
    connections: usize,
    listening_listeners: Vec<NetVoidListener>,
    close_listeners: Vec<NetVoidListener>,
    connection_listeners: Vec<NetConnectionListener>,
    error_listeners: Vec<NetErrorListener>,
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
        for listener in &self.error_listeners {
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
        self.error_listeners.clear();
        self.close_override = None;
        self.http = None;
        self.tls_config = None;
    }
}

pub type JsNetServer = Gc<NetServerData>;

enum NetTask {
    Listening(JsNetServer),
    Close(JsNetServer),
    ServerError(JsNetServer, JsError),
    SocketConnect(JsNetSocket),
    SocketSecureConnect(JsNetSocket),
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

fn net_socket_new_stream(stream: NetStream, server: Option<JsNetServer>) -> JsNetSocket {
    net_register_loop_hooks();
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
        had_error: false,
        timeout_ms: None,
        timeout_timer: None,
        bytes_written: 0,
        write_queue: VecDeque::new(),
        write_offset: 0,
        finish_listeners: Vec::new(),
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connect_listeners: Vec::new(),
        secure_connect_listeners: Vec::new(),
        timeout_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    NET_SOCKETS.with(|sockets| sockets.borrow_mut().push(socket.clone()));
    socket
}

pub fn net_server_new() -> JsNetServer {
    net_register_loop_hooks();
    Gc::new(NetServerData {
        listener: None,
        port: 0,
        closing: false,
        connections: 0,
        listening_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connection_listeners: Vec::new(),
        error_listeners: Vec::new(),
        close_override: None,
        http: None,
        tls_config: None,
    })
}

pub fn net_server_new_callback(callback: Rc<dyn Fn(JsNetSocket)>, trace: NetTrace) -> JsNetServer {
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

pub fn net_server_on_error(
    server: &JsNetServer,
    callback: Rc<dyn Fn(JsError)>,
    trace: NetTrace,
    once: bool,
) {
    server.with_mut(|server| {
        server.error_listeners.push(NetErrorListener {
            invoke: callback,
            trace,
            once,
        });
    });
}

pub fn net_server_off_error(server: &JsNetServer) {
    server.with_mut(|server| server.error_listeners.clear());
}

fn net_server_register(server: &JsNetServer) {
    net_register_loop_hooks();
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
        server.listener = Some(NetListener::Tcp(listener));
        server.port = actual_port;
        server.closing = false;
    });
    net_server_register(server);
    NET_TASKS.with(|tasks| {
        tasks
            .borrow_mut()
            .push_back(NetTask::Listening(server.clone()))
    });
}

#[cfg(unix)]
fn local_server_listener(path: &str) -> std::io::Result<LocalListener> {
    use std::sync::atomic::Ordering;
    let listener = std::os::unix::net::UnixListener::bind(path)?;
    let path = path.to_owned();
    let thread_path = path.clone();
    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let thread_closed = closed.clone();
    let (sender, accepted) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        while !thread_closed.load(Ordering::Acquire) {
            let result = listener.accept().and_then(|(writer, _)| {
                if thread_closed.load(Ordering::Acquire) {
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                let reader = writer.try_clone()?;
                let (events_sender, events) = std::sync::mpsc::channel();
                local_stream_reader(reader, events_sender);
                Ok(NetStream::Local(LocalStream {
                    writer,
                    events,
                    buffered: VecDeque::new(),
                    ended: false,
                    error: None,
                }))
            });
            if sender.send(result).is_err() {
                break;
            }
        }
        let _ = std::fs::remove_file(thread_path);
    });
    Ok(LocalListener {
        accepted,
        closed,
        path,
    })
}

#[cfg(windows)]
fn local_server_listener(path: &str) -> std::io::Result<LocalListener> {
    use std::sync::atomic::Ordering;
    let mut builder = miow::pipe::NamedPipeBuilder::new(path);
    let first = builder.first(true).create()?;
    let path = path.to_owned();
    let thread_path = path.clone();
    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let thread_closed = closed.clone();
    let (sender, accepted) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut next = Some(first);
        while !thread_closed.load(Ordering::Acquire) {
            let pipe = match next.take() {
                Some(pipe) => pipe,
                None => {
                    let mut builder = miow::pipe::NamedPipeBuilder::new(&thread_path);
                    match builder.first(false).create() {
                        Ok(pipe) => pipe,
                        Err(error) => {
                            let _ = sender.send(Err(error));
                            break;
                        }
                    }
                }
            };
            let result = pipe.connect().and_then(|()| {
                if thread_closed.load(Ordering::Acquire) {
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                let pipe = WindowsPipe(std::sync::Arc::new(pipe));
                let reader = pipe.clone();
                let (events_sender, events) = std::sync::mpsc::channel();
                local_stream_reader(reader, events_sender);
                Ok(NetStream::Local(LocalStream {
                    writer: LocalStreamWriter::Pipe(pipe),
                    events,
                    buffered: VecDeque::new(),
                    ended: false,
                    error: None,
                }))
            });
            if sender.send(result).is_err() {
                break;
            }
        }
    });
    Ok(LocalListener {
        accepted,
        closed,
        path,
    })
}

#[cfg(not(any(unix, windows)))]
fn local_server_listener(_path: &str) -> std::io::Result<LocalListener> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "local socket servers are not supported on this target",
    ))
}

pub fn net_server_listen_path(server: &JsNetServer, path: &JsString) {
    match local_server_listener(path.to_utf8_lossy()) {
        Ok(listener) => {
            server.with_mut(|server| {
                server.listener = Some(NetListener::Local(listener));
                server.port = 0;
                server.closing = false;
            });
            net_server_register(server);
            NET_TASKS.with(|tasks| {
                tasks
                    .borrow_mut()
                    .push_back(NetTask::Listening(server.clone()));
            });
        }
        Err(error) => {
            let code = fs_error_code(&error);
            let text = fs_error_text(&error);
            let error = JsError {
                identity: Rc::new(()),
                name: "Error".to_owned(),
                message: format!("{code}: {text}, listen '{}'", path),
                code: Some(code.to_owned()),
                cause: None,
                dom: None,
            };
            NET_TASKS.with(|tasks| {
                tasks
                    .borrow_mut()
                    .push_back(NetTask::ServerError(server.clone(), error));
            });
        }
    }
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
            .and_then(|listener| match listener {
                NetListener::Tcp(listener) => listener.local_addr().ok(),
                NetListener::Local(_) => None,
            })
    })
}

/// The bound TCP port, or 0 before `listen` completes.
pub fn net_server_address_port(server: &JsNetServer) -> f64 {
    net_server_local_address(server).map_or(0.0, |address| f64::from(address.port()))
}

pub fn net_server_address_ip(server: &JsNetServer) -> JsString {
    string(
        &net_server_local_address(server)
            .map_or_else(|| "0.0.0.0".to_owned(), |address| address.ip().to_string()),
    )
}

pub fn net_server_address_family(server: &JsNetServer) -> JsString {
    string(
        if net_server_local_address(server).is_some_and(|address| address.is_ipv6()) {
            "IPv6"
        } else {
            "IPv4"
        },
    )
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
    let override_ =
        server.with(|server| server.close_override.as_ref().map(|value| value.0.clone()));
    if let Some(override_) = override_ {
        override_();
    } else {
        net_server_close_direct(server);
    }
}

/// Allocate a disconnected socket. It is not a referenced event-loop handle
/// until a connection is started, but listeners can already be installed.
pub fn net_socket_new() -> JsNetSocket {
    net_register_loop_hooks();
    Gc::new(NetSocketData {
        stream: None,
        pending_connect: None,
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
        had_error: false,
        timeout_ms: None,
        timeout_timer: None,
        bytes_written: 0,
        write_queue: VecDeque::new(),
        write_offset: 0,
        finish_listeners: Vec::new(),
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connect_listeners: Vec::new(),
        secure_connect_listeners: Vec::new(),
        timeout_listeners: Vec::new(),
        error_listeners: Vec::new(),
    })
}

fn net_register_socket(socket: &JsNetSocket) {
    NET_SOCKETS.with(|sockets| {
        let mut sockets = sockets.borrow_mut();
        if !sockets.iter().any(|candidate| candidate.ptr_eq(socket)) {
            sockets.push(socket.clone());
        }
    });
}

pub fn net_socket_connect_deferred(port: f64, host: &JsString) -> JsNetSocket {
    let port = net_port(port);
    let socket = net_socket_new();
    socket.with_mut(|state| {
        state.pending_connect = Some(NetEndpoint::Tcp(host.to_string(), port));
    });
    net_register_socket(&socket);
    socket
}

/// Start a first TCP connection on the same previously disconnected socket.
pub fn net_socket_connect_existing(socket: &JsNetSocket, port: f64, host: &JsString) -> JsNetSocket {
    let port = net_port(port);
    let available = socket.with_mut(|state| {
        if state.destroyed
            || state.pending_connect.is_some()
            || state.connect_rx.is_some()
            || state.stream.is_some()
        {
            return false;
        }
        state.pending_connect = Some(NetEndpoint::Tcp(host.to_string(), port));
        true
    });
    if !available {
        throw_error_code(
            "scriptc: reconnecting or connecting an active socket is not supported yet".into(),
            "SC1031",
        );
    }
    net_register_socket(socket);
    net_socket_start_connect(socket);
    socket.clone()
}

fn local_stream_reader(
    mut reader: impl std::io::Read + Send + 'static,
    sender: std::sync::mpsc::Sender<LocalStreamEvent>,
) {
    std::thread::spawn(move || {
        loop {
            let mut buffer = vec![0_u8; 65_536];
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => {
                    let _ = sender.send(LocalStreamEvent::End);
                    break;
                }
                Ok(length) => {
                    buffer.truncate(length);
                    if sender.send(LocalStreamEvent::Data(buffer)).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::UnexpectedEof
                    ) =>
                {
                    let _ = sender.send(LocalStreamEvent::End);
                    break;
                }
                Err(error) => {
                    let _ = sender.send(LocalStreamEvent::Error(format!(
                        "read {}",
                        fs_error_code(&error)
                    )));
                    break;
                }
            }
        }
    });
}

#[cfg(unix)]
fn local_stream_connect(path: &str) -> std::io::Result<NetStream> {
    let writer = std::os::unix::net::UnixStream::connect(path)?;
    let reader = writer.try_clone()?;
    let (sender, events) = std::sync::mpsc::channel();
    local_stream_reader(reader, sender);
    Ok(NetStream::Local(LocalStream {
        writer,
        events,
        buffered: VecDeque::new(),
        ended: false,
        error: None,
    }))
}

#[cfg(windows)]
fn local_stream_connect(path: &str) -> std::io::Result<NetStream> {
    let writer = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    let reader = writer.try_clone()?;
    let (sender, events) = std::sync::mpsc::channel();
    local_stream_reader(reader, sender);
    Ok(NetStream::Local(LocalStream {
        writer: LocalStreamWriter::File(writer),
        events,
        buffered: VecDeque::new(),
        ended: false,
        error: None,
    }))
}

#[cfg(not(any(unix, windows)))]
fn local_stream_connect(_path: &str) -> std::io::Result<NetStream> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "local sockets are not supported on this target",
    ))
}

pub fn net_socket_connect_path(path: &JsString) -> JsNetSocket {
    net_register_loop_hooks();
    let socket = Gc::new(NetSocketData {
        stream: None,
        pending_connect: Some(NetEndpoint::Local(path.to_string())),
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
        had_error: false,
        timeout_ms: None,
        timeout_timer: None,
        bytes_written: 0,
        write_queue: VecDeque::new(),
        write_offset: 0,
        finish_listeners: Vec::new(),
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        close_listeners: Vec::new(),
        connect_listeners: Vec::new(),
        secure_connect_listeners: Vec::new(),
        timeout_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    NET_SOCKETS.with(|sockets| sockets.borrow_mut().push(socket.clone()));
    net_socket_start_connect(&socket);
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
    let Some(endpoint) = endpoint else {
        return;
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = match endpoint {
            NetEndpoint::Tcp(host, port) => std::net::TcpStream::connect((host.as_str(), port))
                .map(NetStream::Tcp)
                .map_err(|error| {
                    let code = fs_error_code(&error);
                    NetConnectError { code, message: format!("connect {code} {host}:{port}") }
                }),
            NetEndpoint::Local(path) => local_stream_connect(&path).map_err(|error| {
                let code = fs_error_code(&error);
                NetConnectError { code, message: format!("connect {code} {path}") }
            }),
        };
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
    match encoding.to_utf8_lossy() {
        "utf8" | "utf-8" => socket.with_mut(|socket| socket.encoding_utf8 = true),
        "ascii" | "latin1" | "binary" | "base64" | "base64url" | "hex" | "ucs2" | "ucs-2"
        | "utf16le" | "utf-16le" => throw_error(format!(
            "setEncoding('{encoding}') is not supported yet (only 'utf8' here)"
        )),
        _ => throw_type_error_code(
            format!("Unknown encoding: {encoding}"),
            "ERR_UNKNOWN_ENCODING",
        ),
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

pub fn net_socket_on_timeout(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
) {
    net_socket_on_void(socket, callback, trace, once, |socket| {
        &mut socket.timeout_listeners
    });
}

fn net_socket_arm_timeout(socket: &JsNetSocket) {
    let delay = socket.with(|state| {
        (!state.destroyed && state.timeout_timer.is_none())
            .then_some(state.timeout_ms)
            .flatten()
            .filter(|delay| *delay > 0.0)
    });
    let Some(delay) = delay else { return };
    let weak = socket.downgrade();
    let timer = timer_set_timeout_handle(
        Box::new(move || {
            let Some(socket) = weak.upgrade() else { return };
            let listeners = socket.with_mut(|state| {
                state.timeout_timer = None;
                if state.destroyed {
                    Vec::new()
                } else {
                    net_dispatch_listeners(&mut state.timeout_listeners)
                }
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }),
        delay,
    );
    timer_set_ref(timer, false);
    socket.with_mut(|state| state.timeout_timer = Some(timer));
}

fn net_socket_touch(socket: &JsNetSocket) {
    if let Some(timer) = socket.with(|state| state.timeout_timer) {
        timer_refresh(timer);
    } else {
        net_socket_arm_timeout(socket);
    }
}

pub fn net_socket_validate_timeout(delay: f64) {
    if !delay.is_finite() || delay < 0.0 {
        throw_range_error_code(
            format!("The value of \"msecs\" is out of range. Received {delay}"),
            "ERR_OUT_OF_RANGE",
        );
    }
    if delay > f64::from(i32::MAX) {
        throw_error_code(
            "scriptc: socket timeouts above 2147483647 ms are not supported yet".into(),
            "SC1031",
        );
    }
}

pub fn net_socket_set_timeout(socket: &JsNetSocket, delay: f64) -> JsNetSocket {
    net_socket_validate_timeout(delay);
    let previous = socket.with_mut(|state| {
        state.timeout_ms = Some(delay);
        state.timeout_timer.take()
    });
    if let Some(timer) = previous {
        timer_clear(timer);
    }
    net_socket_arm_timeout(socket);
    socket.clone()
}

pub fn net_socket_timeout(socket: &JsNetSocket) -> Option<f64> {
    socket.with(|state| state.timeout_ms)
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

pub fn net_socket_connecting(socket: &JsNetSocket) -> bool {
    socket.with(|socket| socket.pending_connect.is_some() || socket.connect_rx.is_some())
}

pub fn net_socket_had_error(socket: &JsNetSocket) -> bool {
    socket.with(|socket| socket.had_error)
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
    socket.with(|socket| socket.stream.as_ref().and_then(NetStream::peer_address))
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
            stream.set_no_delay(enabled);
        }
    });
    socket.clone()
}

pub fn net_socket_destroy_soon(socket: &JsNetSocket) {
    net_socket_end(socket);
}

pub fn net_socket_destroy(socket: &JsNetSocket) {
    let (schedule, server, timer) = socket.with_mut(|socket| {
        if socket.destroyed {
            return (false, None, None);
        }
        if let Some(mut stream) = socket.stream.take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        socket.connect_rx = None;
        socket.pending_connect = None;
        socket.tls = None;
        socket.destroyed = true;
        socket.writable = false;
        socket.write_queue.clear();
        socket.write_offset = 0;
        (
            !socket.close_emitted,
            socket.server.take(),
            socket.timeout_timer.take(),
        )
    });
    if let Some(timer) = timer {
        timer_clear(timer);
    }
    NET_SOCKETS.with(|sockets| {
        sockets
            .borrow_mut()
            .retain(|candidate| !candidate.ptr_eq(socket))
    });
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
                servers
                    .borrow_mut()
                    .retain(|candidate| !candidate.ptr_eq(&server));
            });
            let listeners = server.with_mut(|server| {
                server.closing = false;
                net_dispatch_listeners(&mut server.close_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }
        NetTask::ServerError(server, error) => {
            let listeners = server.with_mut(|server| {
                let listeners = server.error_listeners.clone();
                server.error_listeners.retain(|listener| !listener.once);
                listeners
            });
            if listeners.is_empty() {
                throw_value(error);
            }
            for listener in listeners {
                (listener.invoke)(error.clone());
            }
        }
        NetTask::SocketConnect(socket) => {
            net_socket_touch(&socket);
            let listeners =
                socket.with_mut(|socket| net_dispatch_listeners(&mut socket.connect_listeners));
            for listener in listeners {
                (listener.invoke)();
            }
        }
        NetTask::SocketSecureConnect(socket) => {
            net_socket_touch(&socket);
            let listeners = socket.with_mut(|socket| {
                net_dispatch_listeners(&mut socket.secure_connect_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }
        NetTask::SocketError(socket, error) => {
            let listeners = socket.with_mut(|socket| {
                socket.had_error = true;
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
                (std::mem::take(&mut socket.end_listeners), !socket.writable)
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
                socket.secure_connect_listeners.clear();
                socket.timeout_listeners.clear();
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
                let accepted = match listener {
                    NetListener::Tcp(listener) => {
                        listener.accept().map(|(stream, _)| NetStream::Tcp(stream))
                    }
                    NetListener::Local(listener) => listener.accept(),
                };
                match accepted {
                    Ok(stream) => Some((candidate.clone(), stream)),
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
        server
            .connection_listeners
            .retain(|listener| !listener.once);
        snapshot
    });
    server.with_mut(|server| server.connections += 1);
    let socket = net_socket_new_stream(stream, Some(server.clone()));
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
                                Some(NetTask::SocketConnect(candidate.clone()))
                            }
                            Err(error) => {
                                let code = fs_error_code(&error);
                                Some(NetTask::SocketError(
                                    candidate.clone(),
                                    error_new_code("Error", string(&format!("connect {code}")), code),
                                ))
                            }
                        }
                    }
                    Ok(Err(error)) => {
                        socket.connect_rx = None;
                        Some(NetTask::SocketError(
                            candidate.clone(),
                            error_new_code("Error", string(&error.message), error.code),
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
    let connected = matches!(task, NetTask::SocketConnect(_));
    NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(task));
    // A worker can finish after this poll's accept check. Preserve accept
    // priority, queueing completion first so a throwing handler cannot lose it.
    if connected {
        net_accept_one();
    }
    true
}

fn net_socket_flush_one() -> bool {
    enum Flush {
        Idle,
        Progress(JsNetSocket, Option<NetVoidListener>, bool),
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
                                socket
                                    .write_queue
                                    .pop_front()
                                    .and_then(|write| write.callback)
                            } else {
                                None
                            };
                            Flush::Progress(candidate.clone(), callback, true)
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Flush::Idle,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                            Flush::Progress(candidate.clone(), None, false)
                        }
                        Err(_) => Flush::Close(candidate.clone(), Vec::new()),
                    }
                } else if socket.end_requested {
                    if let Some(stream) = socket.stream.as_mut() {
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
        Some(Flush::Progress(socket, callback, wrote)) => {
            if wrote {
                net_socket_touch(&socket);
            }
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
            net_socket_touch(&socket);
            let (listeners, encoding_utf8) = socket.with_mut(|socket| {
                let snapshot = socket.data_listeners.clone();
                socket.data_listeners.retain(|listener| !listener.once);
                (snapshot, socket.encoding_utf8)
            });
            let chunk = bytes_from_elements(bytes);
            chunk.with_mut(|data| data.buffer = true);
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
