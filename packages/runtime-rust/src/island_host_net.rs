/* The island's SOCKET bridge: node:net over the compiled runtime's own
 * network unit.
 *
 * island_host_io.rs answers the calls that reach the filesystem; this one
 * answers the calls that reach a socket. Every function here delegates to
 * the SAME `net_*` primitive the static lane lowers to, so an island
 * `net.createConnection` and a compiled `net.createConnection` are one
 * TcpStream family on one event loop, one liveness account, one ordering.
 *
 * THE REENTRY RULE (the timer bridge's, one level harder). A host
 * function runs while `ISLAND_STATE` is ALREADY borrowed by the call that
 * reached it, so nothing here may re-enter the realm: `netConnect` only
 * mints a socket, files listener closures on it and returns an id. Those
 * closures fire LATER, from the net dispatch station on the loop's own
 * turn, where no borrow is live — and only there do they re-enter through
 * `island_net_call`, which takes the borrow, calls one method on the
 * shim's callbacks object, drains the microtasks it queued and drops the
 * borrow again. That is the same macrotask boundary `island_timer_fire`
 * draws, and it is why a socket callback may freely call back into
 * `host.netWrite` from inside the realm.
 *
 * IDENTITY IS AN INTEGER. The realm never holds a Gc handle: the shim
 * speaks in socket ids and server ids, and this file owns the only map
 * from an id to the runtime object. `island_net_reset` drops that map on
 * teardown, before the heap audit, so an island that dies mid-connection
 * still lands at zero live traced objects.
 *
 * FLOW CONTROL IS THE SHIM'S. `net_socket_on_data` starts a socket
 * flowing the moment a listener is filed, but a Node socket is PAUSED
 * until something reads it. So every wiring here re-pauses unless the
 * shim has already asked to resume, and `host.netResume`/`host.netPause`
 * carry Node's `.on('data')`/`.pause()` through to the same flag the
 * static lane sets.
 */

/// One live island socket: the runtime handle plus whether the shim has
/// asked for flow yet (see FLOW CONTROL above).
struct IslandNetSocketEntry {
    socket: JsNetSocket,
    resumed: bool,
}

thread_local! {
    static ISLAND_NET_SOCKETS: RefCell<HashMap<u64, IslandNetSocketEntry>> =
        RefCell::new(HashMap::new());
    static ISLAND_NET_SERVERS: RefCell<HashMap<u64, JsNetServer>> = RefCell::new(HashMap::new());
    /// The shim callbacks object each server was created with, kept so a
    /// FAILED `listen` still has somewhere to report (see
    /// `island_net_defer_server_error`).
    static ISLAND_NET_SERVER_CALLBACKS: RefCell<HashMap<u64, boa_engine::JsObject>> =
        RefCell::new(HashMap::new());
    static ISLAND_NET_NEXT_ID: Cell<u64> = const { Cell::new(0) };
}

fn island_net_next_id() -> u64 {
    ISLAND_NET_NEXT_ID.with(|slot| {
        let id = slot.get().checked_add(1).unwrap_or(1);
        slot.set(id);
        id
    })
}

/// Release every island socket and server before the realm goes down.
///
/// Called from `island_eval_finish`, which runs before `collect_cycles`
/// and the heap audit, so a program that exits mid-connection still
/// proves zero live traced objects.
fn island_net_reset() {
    let sockets = ISLAND_NET_SOCKETS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    for entry in sockets.into_values() {
        net_socket_destroy(&entry.socket);
    }
    let servers = ISLAND_NET_SERVERS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    for server in servers.into_values() {
        net_server_close_direct(&server);
    }
    ISLAND_NET_SERVER_CALLBACKS.with(|slot| slot.borrow_mut().clear());
    island_http_reset();
    ISLAND_NET_NEXT_ID.with(|slot| slot.set(0));
}

fn island_net_socket(id: u64) -> Option<JsNetSocket> {
    ISLAND_NET_SOCKETS.with(|sockets| {
        sockets
            .borrow()
            .get(&id)
            .map(|entry| entry.socket.clone())
    })
}

fn island_net_server(id: u64) -> Option<JsNetServer> {
    ISLAND_NET_SERVERS.with(|servers| servers.borrow().get(&id).cloned())
}

/// `arguments[index]` as a registry id, or 0 when the shim passed none.
fn island_net_arg_id(arguments: &[JsValue], index: usize) -> u64 {
    let value = arguments
        .get(index)
        .and_then(JsValue::as_number)
        .unwrap_or(0.0);
    if value.is_finite() && value >= 1.0 && value.fract() == 0.0 {
        value as u64
    } else {
        0
    }
}

/// `arguments[index]` as the shim's callbacks object.
fn island_net_arg_callbacks(
    arguments: &[JsValue],
    index: usize,
) -> JsResult<boa_engine::JsObject> {
    island_host_arg(arguments, index)
        .as_object()
        .ok_or_else(|| {
            boa_engine::JsNativeError::typ()
                .with_message("the island socket bridge expects a callbacks object")
                .into()
        })
}

/* ── the reentry seam ──────────────────────────────────────────────── */

/// Call one method on a shim callbacks object FROM THE LOOP.
///
/// The realm borrow is taken here and dropped on the way out, so this is
/// only ever legal from a net dispatch closure — never from a host
/// function, which already runs inside a borrow. The queued microtasks
/// drain before the loop advances: the island's socket events settle
/// their promise continuations on the same macrotask, which is Node's
/// ordering and what `island_timer_fire` does for timers.
fn island_net_call(
    callbacks: &boa_engine::JsObject,
    name: &str,
    build: impl FnOnce(&mut Context) -> Vec<JsValue>,
) -> JsValue {
    let callbacks = callbacks.clone();
    with_island_state(|state| {
        let answer = {
            let context = &mut state.context;
            let member = callbacks
                .get(boa_engine::JsString::from(name), context)
                .unwrap_or_else(|error| island_eval_error(error, context));
            match member.as_callable() {
                Some(function) => {
                    let arguments = build(context);
                    function
                        .call(&callbacks.clone().into(), &arguments, context)
                        .unwrap_or_else(|error| island_eval_error(error, context))
                }
                None => JsValue::undefined(),
            }
        };
        island_run_jobs(state);
        answer
    })
}

/// A runtime socket error as the message string the shim rebuilds an
/// `Error` from (it recovers `code`/`syscall` off the same text the C
/// bridge hands over, so both islands read one wording).
fn island_net_error_text(error: &JsError) -> String {
    error_message(error).to_string()
}

/* ── socket wiring ─────────────────────────────────────────────────── */

/// File the five socket listeners the shim's callbacks object answers.
///
/// Every closure captures the callbacks object (a Boa root, which is what
/// keeps the shim's Socket reachable) and the socket's id. None of them
/// runs now: they run from the loop, which is the only place re-entering
/// the realm is legal.
fn island_net_wire_socket(socket: &JsNetSocket, id: u64, callbacks: &boa_engine::JsObject) {
    let connect_callbacks = callbacks.clone();
    net_socket_on_connect(
        socket,
        Rc::new(move || {
            island_net_call(&connect_callbacks, "onConnect", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        true,
    );

    let data_callbacks = callbacks.clone();
    net_socket_on_data(
        socket,
        Rc::new(move |chunk, _encoding_utf8| {
            island_net_call(&data_callbacks, "onData", |context| {
                let bytes = BoaJsUint8Array::from_iter(bytes_u8_values(&chunk), context)
                    .map(JsValue::from)
                    .unwrap_or_else(|error| island_eval_error(error, context));
                vec![bytes]
            });
        }),
        Rc::new(|_| {}),
        false,
    );

    let end_callbacks = callbacks.clone();
    net_socket_on_end(
        socket,
        Rc::new(move || {
            island_net_call(&end_callbacks, "onEnd", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        true,
    );

    let error_callbacks = callbacks.clone();
    net_socket_on_error(
        socket,
        Rc::new(move |error| {
            let text = island_net_error_text(&error);
            island_net_call(&error_callbacks, "onError", |_| {
                vec![JsValue::from(boa_engine::JsString::from(text.as_str()))]
            });
        }),
        Rc::new(|_| {}),
        false,
    );

    let close_callbacks = callbacks.clone();
    net_socket_on_close(
        socket,
        Rc::new(move || {
            ISLAND_NET_SOCKETS.with(|sockets| sockets.borrow_mut().remove(&id));
            island_net_call(&close_callbacks, "onClose", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        true,
    );
}

/// Register a socket and re-pause it unless the shim already read.
fn island_net_adopt(socket: &JsNetSocket, id: u64, callbacks: &boa_engine::JsObject) {
    island_net_wire_socket(socket, id, callbacks);
    let resumed = ISLAND_NET_SOCKETS.with(|sockets| {
        sockets
            .borrow_mut()
            .entry(id)
            .and_modify(|entry| entry.socket = socket.clone())
            .or_insert_with(|| IslandNetSocketEntry {
                socket: socket.clone(),
                resumed: false,
            })
            .resumed
    });
    if resumed {
        net_socket_resume(socket);
    } else {
        net_socket_pause(socket);
    }
}

/* ── the socket host functions ─────────────────────────────────────── */

/// `host.netConnect(port, host, callbacks)` → a socket id.
///
/// The dial itself is `net_socket_connect`, the static lane's: a
/// background resolve/connect whose completion the loop reports through
/// `onConnect` (or `onError`) — so `net.createConnection` inside the
/// island is the same syscall sequence a compiled one makes.
fn island_host_net_connect(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let port = island_host_arg_number(arguments, 0, context)?;
    let hostname: JsString = Rc::from(island_host_arg_string(arguments, 1, context)?.as_str());
    let callbacks = island_net_arg_callbacks(arguments, 2)?;
    let socket = island_host_run(|| net_socket_connect(port, &hostname), context)?;
    let id = island_net_next_id();
    island_net_adopt(&socket, id, &callbacks);
    Ok(JsValue::from(id as f64))
}

fn island_host_net_write(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(socket) = island_net_socket(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::from(false));
    };
    let bytes = island_host_arg_bytes(arguments, 1, context)?;
    island_host_run(|| net_socket_write_bytes(&socket, &bytes), context)?;
    Ok(JsValue::from(true))
}

/// `host.netEnd(id, bytes | undefined)` — the half-close, with the final
/// chunk riding END so it lands in ONE write the way Node's does.
fn island_host_net_end(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(socket) = island_net_socket(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::undefined());
    };
    if island_host_arg(arguments, 1).is_null_or_undefined() {
        island_host_run(|| net_socket_end(&socket), context)?;
    } else {
        let bytes = island_host_arg_bytes(arguments, 1, context)?;
        island_host_run(|| net_socket_end_bytes(&socket, &bytes), context)?;
    }
    Ok(JsValue::undefined())
}

fn island_host_net_destroy(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    if let Some(socket) = island_net_socket(island_net_arg_id(arguments, 0)) {
        net_socket_destroy(&socket);
    }
    Ok(JsValue::undefined())
}

/// `host.netFlow(id, resume)` — one call for `.resume()`/`.pause()`, so
/// the flag the shim keeps and the flag the loop reads cannot drift.
fn island_host_net_flow(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let id = island_net_arg_id(arguments, 0);
    let resume = island_host_arg(arguments, 1).to_boolean();
    let socket = ISLAND_NET_SOCKETS.with(|sockets| {
        let mut sockets = sockets.borrow_mut();
        let entry = sockets.get_mut(&id)?;
        entry.resumed = resume;
        Some(entry.socket.clone())
    });
    // No entry means the socket is already gone (closed, or destroyed
    // before the shim let go of its id). Every LIVE socket is registered
    // before the realm can learn its id, so there is no intent to record.
    let Some(socket) = socket else {
        return Ok(JsValue::undefined());
    };
    if resume {
        net_socket_resume(&socket);
    } else {
        net_socket_pause(&socket);
    }
    Ok(JsValue::undefined())
}

/// `host.netOption(id, name, enabled)` → the two socket options Node's
/// `Socket` exposes. `noDelay` is the static lane's `set_nodelay`;
/// `keepAlive` reaches the same SO_KEEPALIVE the platform offers, and
/// answers `false` where it does not, which is what lets the shim keep
/// Node's chainable return without inventing a success.
fn island_host_net_option(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(socket) = island_net_socket(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::from(false));
    };
    let name = island_host_arg_string(arguments, 1, context)?;
    let enabled = island_host_arg(arguments, 2).to_boolean();
    let applied = match name.as_str() {
        "noDelay" => {
            net_socket_set_no_delay(&socket, enabled);
            true
        }
        "keepAlive" => island_net_set_keep_alive(&socket, enabled),
        _ => false,
    };
    Ok(JsValue::from(applied))
}

/// SO_KEEPALIVE on the live stream, or `false` where the platform has no
/// answer — `network.rs` keeps no keepalive state, so this reads the fd
/// directly rather than growing a second one.
#[cfg(all(not(windows), not(target_os = "wasi")))]
fn island_net_set_keep_alive(socket: &JsNetSocket, enabled: bool) -> bool {
    socket.with(|socket| {
        socket.stream.as_ref().is_some_and(|stream| {
            rustix::net::sockopt::set_socket_keepalive(stream, enabled).is_ok()
        })
    })
}

#[cfg(any(windows, target_os = "wasi"))]
fn island_net_set_keep_alive(_socket: &JsNetSocket, _enabled: bool) -> bool {
    false
}

/// `host.netPeer(id)` → `[address, family, port]`, or `undefined` before
/// the socket has one. The shim publishes these as `remoteAddress` and
/// friends only once they exist, exactly as Node does.
fn island_host_net_peer(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(socket) = island_net_socket(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::undefined());
    };
    let peer = socket.with(|socket| {
        socket
            .stream
            .as_ref()
            .and_then(|stream| stream.peer_addr().ok())
    });
    Ok(island_net_address_row(peer, context))
}

/// `host.netLocal(id)` → the bound side of the same pair.
fn island_host_net_local(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(socket) = island_net_socket(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::undefined());
    };
    let local = socket.with(|socket| {
        socket
            .stream
            .as_ref()
            .and_then(|stream| stream.local_addr().ok())
    });
    Ok(island_net_address_row(local, context))
}

/// `[address, family, port]` — the row both islands' shims destructure.
fn island_net_address_row(
    address: Option<std::net::SocketAddr>,
    context: &mut Context,
) -> JsValue {
    let Some(address) = address else {
        return JsValue::undefined();
    };
    let family = if address.is_ipv6() { "IPv6" } else { "IPv4" };
    BoaJsArray::from_iter(
        [
            JsValue::from(boa_engine::JsString::from(address.ip().to_string().as_str())),
            JsValue::from(boa_engine::JsString::from(family)),
            JsValue::from(f64::from(address.port())),
        ],
        context,
    )
    .into()
}

/* ── the server host functions ─────────────────────────────────────── */

/// `host.netServerCreate(callbacks)` → a server id.
///
/// `onConnection(socketId, address, family, port)` RETURNS that socket's
/// callbacks object — the C island's `onRequest` shape, for the same
/// reason: the accepted socket exists before the shim can have wired
/// anything to it, so the return value is the wiring.
fn island_host_net_server_create(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let callbacks = island_net_arg_callbacks(arguments, 0)?;
    let server = net_server_new();
    let id = island_net_next_id();

    let connection_callbacks = callbacks.clone();
    net_server_on_connection(
        &server,
        Rc::new(move |connection: JsNetSocket| {
            let socket_id = island_net_next_id();
            ISLAND_NET_SOCKETS.with(|sockets| {
                sockets.borrow_mut().insert(
                    socket_id,
                    IslandNetSocketEntry {
                        socket: connection.clone(),
                        resumed: false,
                    },
                );
            });
            let peer = connection.with(|socket| {
                socket
                    .stream
                    .as_ref()
                    .and_then(|stream| stream.peer_addr().ok())
            });
            let answer = island_net_call(&connection_callbacks, "onConnection", |context| {
                vec![
                    JsValue::from(socket_id as f64),
                    island_net_address_row(peer, context),
                ]
            });
            match answer.as_object() {
                Some(wiring) => island_net_adopt(&connection, socket_id, &wiring),
                // The shim refused the connection (or threw): drop it
                // rather than leaving an unreadable socket on the loop.
                None => {
                    ISLAND_NET_SOCKETS.with(|sockets| sockets.borrow_mut().remove(&socket_id));
                    net_socket_destroy(&connection);
                }
            }
        }),
        Rc::new(|_| {}),
        false,
    );

    let listening_callbacks = callbacks.clone();
    net_server_on_listening(
        &server,
        Rc::new(move || {
            island_net_call(&listening_callbacks, "onListening", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        false,
    );

    let close_callbacks = callbacks.clone();
    net_server_on_close(
        &server,
        Rc::new(move || {
            island_net_call(&close_callbacks, "onClose", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        false,
    );

    ISLAND_NET_SERVERS.with(|servers| servers.borrow_mut().insert(id, server));
    ISLAND_NET_SERVER_CALLBACKS.with(|slot| slot.borrow_mut().insert(id, callbacks));
    Ok(JsValue::from(id as f64))
}

/// `host.netServerListen(id, port, host)`.
///
/// A bind failure is Node's ASYNCHRONOUS `'error'`, not a throw at the
/// call — so the caught runtime error is handed to the shim's `onError`
/// off a zero-delay native timer, which is the loop turn the real
/// `'listening'` would have arrived on.
fn island_host_net_server_listen(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let id = island_net_arg_id(arguments, 0);
    let Some(server) = island_net_server(id) else {
        return Ok(JsValue::undefined());
    };
    let port = island_host_arg_number(arguments, 1, context)?;
    let hostname: JsString = if island_host_arg(arguments, 2).is_null_or_undefined() {
        Rc::from("")
    } else {
        Rc::from(island_host_arg_string(arguments, 2, context)?.as_str())
    };
    let listened = island_host_guard(|| {
        net_server_listen_options(&server, port, &hostname, false);
    });
    if let Err(caught) = listened {
        island_net_defer_server_error(id, caught_error_message(&caught).to_string());
    }
    Ok(JsValue::undefined())
}

/// Report a listen failure on the next loop turn (see the note above).
fn island_net_defer_server_error(id: u64, message: String) {
    let callbacks = island_net_server_callbacks(id);
    let mut once = Some((callbacks, message));
    let fire: Box<dyn FnMut()> = Box::new(move || {
        let Some((callbacks, message)) = once.take() else {
            return;
        };
        let Some(callbacks) = callbacks else {
            return;
        };
        island_net_call(&callbacks, "onError", |_| {
            vec![JsValue::from(boa_engine::JsString::from(message.as_str()))]
        });
    });
    timer_set_timeout_handle(fire, 0.0);
}

fn island_net_server_callbacks(id: u64) -> Option<boa_engine::JsObject> {
    ISLAND_NET_SERVER_CALLBACKS.with(|slot| slot.borrow().get(&id).cloned())
}

fn island_host_net_server_address(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(server) = island_net_server(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::undefined());
    };
    let address = server.with(|server| {
        server
            .listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok())
    });
    Ok(island_net_address_row(address, context))
}

fn island_host_net_server_close(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let id = island_net_arg_id(arguments, 0);
    if let Some(server) = island_net_server(id) {
        net_server_close_direct(&server);
    }
    Ok(JsValue::undefined())
}

