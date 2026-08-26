fn tls_server_config(cert: &JsString, key: &JsString) -> Arc<rustls::ServerConfig> {
    let mut cert_cursor = std::io::Cursor::new(cert.as_bytes());
    let certificates = rustls_pemfile::certs(&mut cert_cursor)
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|_| throw_error("PEM routines: no start line".to_owned()));
    if certificates.is_empty() {
        throw_error("PEM routines: no start line".to_owned());
    }
    let mut key_cursor = std::io::Cursor::new(key.as_bytes());
    let private_key = rustls_pemfile::private_key(&mut key_cursor)
        .unwrap_or_else(|_| throw_error("PEM routines: no start line".to_owned()))
        .unwrap_or_else(|| throw_error("PEM routines: no start line".to_owned()));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap_or_else(|error| throw_error(error.to_string()))
        .with_no_client_auth()
        .with_single_cert(certificates, private_key)
        .unwrap_or_else(|error| throw_error(error.to_string()));
    Arc::new(config)
}

fn tls_server_attach(server: &JsNetServer, cert: &JsString, key: &JsString) {
    let config = tls_server_config(cert, key);
    server.with_mut(|server| server.tls_config = Some(config));
}

pub fn tls_server_new(cert: &JsString, key: &JsString) -> JsNetServer {
    let server = net_server_new();
    tls_server_attach(&server, cert, key);
    server
}

pub fn tls_server_new_callback(
    cert: &JsString,
    key: &JsString,
    callback: Rc<dyn Fn(JsNetSocket)>,
    trace: NetTrace,
) -> JsNetServer {
    let server = tls_server_new(cert, key);
    net_server_on_connection(&server, callback, trace, false);
    server
}

pub fn https_server_new_callback(
    cert: &JsString,
    key: &JsString,
    callback: Rc<dyn Fn(JsHttpRequest, JsHttpResponse)>,
    trace: NetTrace,
) -> JsNetServer {
    let server = http_server_new_callback(callback, trace);
    tls_server_attach(&server, cert, key);
    server
}

pub fn https_server_new(cert: &JsString, key: &JsString) -> JsNetServer {
    let server = http_server_new();
    tls_server_attach(&server, cert, key);
    server
}

pub fn tls_server_on_secure_connection(
    server: &JsNetServer,
    callback: Rc<dyn Fn(JsNetSocket)>,
    trace: NetTrace,
    once: bool,
) {
    if server.with(|server| server.tls_config.is_some()) {
        net_server_on_connection(server, callback, trace, once);
    }
}

fn tls_server_accept(server: &JsNetServer, socket: &JsNetSocket) -> bool {
    let Some(config) = server.with(|server| server.tls_config.clone()) else {
        return false;
    };
    let connection = rustls::ServerConnection::new(config)
        .unwrap_or_else(|error| throw_error(error.to_string()));
    socket.with_mut(|socket| {
        socket.tls = Some(TlsSocketState {
            connection: rustls::Connection::Server(connection),
            verify_state: Arc::new(Mutex::new(TlsVerifyState::default())),
            server_side: true,
            established: false,
            authorized: false,
            authorization_error: None,
            write_ready: false,
            close_notify_sent: false,
            peer_closed: false,
        });
    });
    true
}

fn tls_server_established(socket: &JsNetSocket) -> bool {
    if !socket.with(|socket| socket.tls.as_ref().is_some_and(|tls| tls.server_side)) {
        return false;
    }
    let Some(server) = socket.with(|socket| socket.server.clone()) else {
        return true;
    };
    if server.with(|server| server.http.is_some()) {
        http_server_accept(&server, socket);
    }
    let listeners = server.with_mut(|server| {
        let snapshot = server.connection_listeners.clone();
        server.connection_listeners.retain(|listener| !listener.once);
        snapshot
    });
    for listener in listeners {
        (listener.invoke)(socket.clone());
    }
    true
}
