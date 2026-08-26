struct TlsSocketState {
    connection: rustls::Connection,
    verify_state: Arc<Mutex<TlsVerifyState>>,
    server_side: bool,
    established: bool,
    authorized: bool,
    authorization_error: Option<String>,
    write_ready: bool,
    close_notify_sent: bool,
    peer_closed: bool,
}

enum TlsSocketAction {
    Progress,
    Connect(JsNetSocket),
    Callback(NetVoidListener),
    Finish(Vec<NetVoidListener>),
    Data(JsNetSocket, Vec<u8>),
    End(JsNetSocket),
    Error(JsNetSocket, String),
    Close(JsNetSocket),
}

fn tls_socket_error(error: &std::io::Error, state: &TlsVerifyState) -> String {
    tls_error_message(error, state.peer_shape)
}

pub fn tls_socket_connect(
    port: f64,
    host: &JsString,
    servername: &JsString,
    reject_unauthorized: bool,
    ca: Option<JsString>,
) -> JsNetSocket {
    let verify_state = Arc::new(Mutex::new(TlsVerifyState::default()));
    let trust = tls_option_trust(ca.map(|value| value.to_string()));
    let config = tls_config(&trust, reject_unauthorized, verify_state.clone())
        .unwrap_or_else(|error| throw_error(error));
    let name = rustls::pki_types::ServerName::try_from(servername.to_string())
        .unwrap_or_else(|_| throw_error(format!("Invalid SNI name: {servername}")));
    let connection = rustls::ClientConnection::new(Arc::new(config), name)
        .unwrap_or_else(|error| throw_error(error.to_string()));
    let socket = net_socket_connect(port, host);
    socket.with_mut(|socket| {
        socket.tls = Some(TlsSocketState {
            connection: rustls::Connection::Client(connection),
            verify_state,
            server_side: false,
            established: false,
            authorized: false,
            authorization_error: None,
            write_ready: false,
            close_notify_sent: false,
            peer_closed: false,
        });
    });
    socket
}

pub fn tls_socket_connect_callback(
    port: f64,
    host: &JsString,
    servername: &JsString,
    reject_unauthorized: bool,
    ca: Option<JsString>,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
) -> JsNetSocket {
    let socket = tls_socket_connect(port, host, servername, reject_unauthorized, ca);
    net_socket_on_connect(&socket, callback, trace, true);
    socket
}

pub fn tls_socket_authorized(socket: &JsNetSocket) -> bool {
    socket.with(|socket| socket.tls.as_ref().is_some_and(|tls| tls.authorized))
}

pub fn tls_socket_authorization_error(socket: &JsNetSocket) -> Option<JsString> {
    socket.with(|socket| {
        socket
            .tls
            .as_ref()
            .and_then(|tls| tls.authorization_error.as_deref())
            .map(string)
    })
}

pub fn tls_socket_encrypted(socket: &JsNetSocket) -> Option<bool> {
    socket.with(|socket| socket.tls.as_ref().map(|_| true))
}

pub fn tls_socket_on_secure_connect(
    socket: &JsNetSocket,
    callback: Rc<dyn Fn()>,
    trace: NetTrace,
    once: bool,
) {
    if socket.with(|socket| socket.tls.is_some()) {
        net_socket_on_connect(socket, callback, trace, once);
    }
}

fn tls_socket_handshake(
    socket: &mut NetSocketData,
    handle: &JsNetSocket,
) -> Option<TlsSocketAction> {
    let stream = socket.stream.as_mut()?;
    let tls = socket.tls.as_mut()?;
    if tls.established {
        return None;
    }
    match tls.connection.complete_io(stream) {
        Ok(_) if tls.connection.is_handshaking() => Some(TlsSocketAction::Progress),
        Ok(_) => {
            if !tls.server_side {
                let verify = tls
                    .verify_state
                    .lock()
                    .expect("scriptc: TLS verify-state lock poisoned");
                tls.authorized = verify.checked && verify.authorization_error.is_none();
                tls.authorization_error = verify.authorization_error.clone();
            }
            tls.established = true;
            Some(TlsSocketAction::Connect(handle.clone()))
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.kind() == std::io::ErrorKind::Interrupted =>
        {
            if tls.connection.is_handshaking() {
                None
            } else {
                if !tls.server_side {
                    let verify = tls
                        .verify_state
                        .lock()
                        .expect("scriptc: TLS verify-state lock poisoned");
                    tls.authorized = verify.checked && verify.authorization_error.is_none();
                    tls.authorization_error = verify.authorization_error.clone();
                }
                tls.established = true;
                Some(TlsSocketAction::Connect(handle.clone()))
            }
        }
        Err(error) => {
            let verify = tls
                .verify_state
                .lock()
                .expect("scriptc: TLS verify-state lock poisoned");
            Some(TlsSocketAction::Error(
                handle.clone(),
                tls_socket_error(&error, &verify),
            ))
        }
    }
}

fn tls_socket_plaintext(
    socket: &mut NetSocketData,
    handle: &JsNetSocket,
) -> Option<TlsSocketAction> {
    let tls = socket.tls.as_mut()?;
    if socket.read_ended || !socket.flowing {
        return None;
    }
    let mut buffer = vec![0_u8; 65_536];
    match tls.connection.reader().read(&mut buffer) {
        Ok(0) => None,
        Ok(length) => {
            buffer.truncate(length);
            Some(TlsSocketAction::Data(handle.clone(), buffer))
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
        Err(error) => Some(TlsSocketAction::Error(handle.clone(), error.to_string())),
    }
}

fn tls_socket_outgoing(
    socket: &mut NetSocketData,
    handle: &JsNetSocket,
) -> Option<TlsSocketAction> {
    if !socket.writable {
        return None;
    }
    let stream = socket.stream.as_mut()?;
    let tls = socket.tls.as_mut()?;
    if tls.connection.wants_write() {
        return match tls.connection.write_tls(stream) {
            Ok(0) => None,
            Ok(_) => Some(TlsSocketAction::Progress),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::Interrupted =>
            {
                None
            }
            Err(error) => Some(TlsSocketAction::Error(handle.clone(), error.to_string())),
        };
    }
    if tls.write_ready {
        tls.write_ready = false;
        socket.write_offset = 0;
        return Some(match socket.write_queue.pop_front().and_then(|write| write.callback) {
            Some(callback) => TlsSocketAction::Callback(callback),
            None => TlsSocketAction::Progress,
        });
    }
    if let Some(write) = socket.write_queue.front() {
        return match tls
            .connection
            .writer()
            .write(&write.bytes[socket.write_offset..])
        {
            Ok(0) => None,
            Ok(length) => {
                socket.write_offset += length;
                if socket.write_offset == write.bytes.len() {
                    tls.write_ready = true;
                }
                Some(TlsSocketAction::Progress)
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
            Err(error) => Some(TlsSocketAction::Error(handle.clone(), error.to_string())),
        };
    }
    if !socket.end_requested {
        return None;
    }
    if !tls.close_notify_sent {
        tls.connection.send_close_notify();
        tls.close_notify_sent = true;
        return Some(TlsSocketAction::Progress);
    }
    if tls.connection.wants_write() {
        return Some(TlsSocketAction::Progress);
    }
    let _ = stream.shutdown(std::net::Shutdown::Write);
    socket.writable = false;
    let listeners = std::mem::take(&mut socket.finish_listeners);
    if socket.read_ended {
        Some(TlsSocketAction::Close(handle.clone()))
    } else {
        Some(TlsSocketAction::Finish(listeners))
    }
}

fn tls_socket_incoming(
    socket: &mut NetSocketData,
    handle: &JsNetSocket,
) -> Option<TlsSocketAction> {
    if socket.read_ended {
        return None;
    }
    let stream = socket.stream.as_mut()?;
    let tls = socket.tls.as_mut()?;
    if tls.peer_closed {
        socket.read_ended = true;
        socket.end_requested = true;
        return Some(TlsSocketAction::End(handle.clone()));
    }
    match tls.connection.read_tls(stream) {
        Ok(0) => {
            tls.peer_closed = true;
            Some(TlsSocketAction::Progress)
        }
        Ok(_) => match tls.connection.process_new_packets() {
            Ok(state) => {
                tls.peer_closed = state.peer_has_closed();
                Some(TlsSocketAction::Progress)
            }
            Err(error) => Some(TlsSocketAction::Error(handle.clone(), error.to_string())),
        },
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.kind() == std::io::ErrorKind::Interrupted =>
        {
            None
        }
        Err(error) => Some(TlsSocketAction::Error(handle.clone(), error.to_string())),
    }
}

fn tls_socket_next_action(socket: &JsNetSocket) -> Option<TlsSocketAction> {
    socket.with_mut(|data| {
        if data.destroyed || data.tls.is_none() || data.connect_rx.is_some() {
            return None;
        }
        if !data.tls.as_ref().is_some_and(|tls| tls.established) {
            return tls_socket_handshake(data, socket);
        }
        tls_socket_plaintext(data, socket)
            .or_else(|| tls_socket_outgoing(data, socket))
            .or_else(|| tls_socket_incoming(data, socket))
    })
}

fn tls_socket_dispatch_one() -> bool {
    let action = NET_SOCKETS.with(|sockets| {
        sockets
            .borrow()
            .iter()
            .find_map(tls_socket_next_action)
    });
    match action {
        Some(TlsSocketAction::Progress) => true,
        Some(TlsSocketAction::Connect(socket)) => {
            if !tls_server_established(&socket) {
                NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::SocketConnect(socket)));
            }
            true
        }
        Some(TlsSocketAction::Callback(callback)) => {
            NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::Callback(callback)));
            true
        }
        Some(TlsSocketAction::Finish(callbacks)) => {
            NET_TASKS.with(|tasks| {
                tasks
                    .borrow_mut()
                    .extend(callbacks.into_iter().map(NetTask::Callback));
            });
            true
        }
        Some(TlsSocketAction::Data(socket, bytes)) => {
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
        Some(TlsSocketAction::End(socket)) => {
            NET_TASKS.with(|tasks| tasks.borrow_mut().push_back(NetTask::SocketEnd(socket)));
            true
        }
        Some(TlsSocketAction::Error(socket, message)) => {
            if socket.with(|data| data.tls.as_ref().is_some_and(|tls| tls.server_side)) {
                net_socket_destroy(&socket);
            } else {
                NET_TASKS.with(|tasks| {
                    tasks.borrow_mut().push_back(NetTask::SocketError(
                        socket,
                        error_new("Error", string(&message)),
                    ));
                });
            }
            true
        }
        Some(TlsSocketAction::Close(socket)) => {
            net_socket_destroy(&socket);
            true
        }
        None => false,
    }
}
