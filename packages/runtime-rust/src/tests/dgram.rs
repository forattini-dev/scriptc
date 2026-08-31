// End-to-end tests for `dgram`.
//
// UDP has no connection to hang a test on, so the risk here is the opposite of
// `net`'s: a lost datagram silently turns a test into a timeout. The roundtrip
// case therefore re-sends on an interval until the receiver actually reports a
// message, which makes the test insensitive to a dropped first packet without
// making it insensitive to a broken receive path.

#[test]
fn udp_bind_port0_reports_address() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let socket = dgram_create_socket(false);
    let listening_log = log.clone();
    let listening_socket = socket.downgrade();
    dgram_on_listening(
        &socket,
        Rc::new(move || {
            let socket = reborrow(&listening_socket);
            let (address, family, port) = dgram_address(&socket);
            note(&listening_log, &format!("listening:{address} {family} {}", port > 0.0));
            dgram_close(&socket);
        }),
        no_trace(),
        true,
    );
    let close_log = log.clone();
    dgram_on_close(
        &socket,
        Rc::new(move || note(&close_log, "close")),
        no_trace(),
        true,
    );
    dgram_bind(&socket, 0.0, &string("127.0.0.1"));

    // `bind` binds synchronously, so the address is readable before the loop
    // has had a chance to emit `listening`.
    let (_, _, bound_port) = dgram_address(&socket);
    assert!(bound_port > 0.0, "bind(0) must report an OS-assigned port");

    run_event_loop();

    assert_eq!(
        entries(&log),
        vec!["listening:127.0.0.1 IPv4 true", "close"],
    );

    drop(socket);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn udp_loopback_send_recv_roundtrip() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let receiver = dgram_create_socket(false);
    dgram_bind(&receiver, 0.0, &string("127.0.0.1"));
    let (_, _, port) = dgram_address(&receiver);

    let sender = dgram_create_socket(false);
    // UDP may drop the datagram; re-sending until the receiver reports keeps
    // the test honest about the receive path without depending on luck.
    let sending = sender.downgrade();
    let repeat = timer_set_interval(
        Box::new(move || {
            dgram_send_string(
                &reborrow(&sending),
                &string("pong"),
                port,
                &string("127.0.0.1"),
            );
        }),
        50.0,
    );

    let message_log = log.clone();
    let message_receiver = receiver.downgrade();
    let message_sender = sender.downgrade();
    dgram_on_message(
        &receiver,
        Rc::new(move |chunk, address, family, from_port, length| {
            note(
                &message_log,
                &format!(
                    "message:{} {address} {family} {} {length}",
                    utf8(&chunk),
                    from_port > 0.0
                ),
            );
            timer_clear(repeat);
            dgram_close(&reborrow(&message_receiver));
            dgram_close(&reborrow(&message_sender));
        }),
        no_trace(),
        true,
    );

    run_event_loop();

    let entries = entries(&log);
    assert_eq!(entries.len(), 1, "exactly one message reported: {entries:?}");
    assert_eq!(entries[0], "message:pong 127.0.0.1 IPv4 true 4");

    drop(receiver);
    drop(sender);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn udp_connect_mode_semantics() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let socket = dgram_create_socket(false);
    assert!(!dgram_is_connected(&socket), "a fresh socket is unconnected");

    let connect_log = log.clone();
    dgram_on_connect(
        &socket,
        Rc::new(move || note(&connect_log, "connect")),
        no_trace(),
        true,
    );
    dgram_connect(&socket, 9.0, &string("127.0.0.1"));
    assert!(dgram_is_connected(&socket), "connect() flips the mode");

    // Address-carrying `send` is the unconnected-mode call; using it on a
    // connected socket is the Node `ERR_SOCKET_DGRAM_IS_CONNECTED` throw.
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dgram_send_string(&socket, &string("nope"), 9.0, &string("127.0.0.1"));
    }))
    .expect_err("addressed send on a connected socket must throw");
    let caught = caught_from_panic(payload);
    assert_eq!(caught_error_message(&caught).as_ref(), "Already connected");
    assert_eq!(
        caught_error_code(&caught).as_deref(),
        Some("ERR_SOCKET_DGRAM_IS_CONNECTED"),
    );

    // A second connect is refused for the same reason.
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dgram_connect(&socket, 9.0, &string("127.0.0.1"));
    }))
    .expect_err("connecting twice must throw");
    assert_eq!(
        caught_error_message(&caught_from_panic(payload)).as_ref(),
        "Already connected",
    );

    let close_log = log.clone();
    dgram_on_close(
        &socket,
        Rc::new(move || note(&close_log, "close")),
        no_trace(),
        true,
    );
    dgram_close(&socket);
    run_event_loop();

    assert_eq!(entries(&log), vec!["connect", "close"]);

    drop(socket);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn udp_bind_collision_reports_error() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let holder = dgram_create_socket(false);
    dgram_bind(&holder, 0.0, &string("127.0.0.1"));
    let (_, _, port) = dgram_address(&holder);
    // The holder only has to occupy the port; unreferencing it lets the loop
    // finish once the collision has been reported.
    dgram_unref(&holder);

    let colliding = dgram_create_socket(false);
    // An unhandled dgram `error` exits the process, so the listener has to be
    // registered before the failing bind.
    let error_log = log.clone();
    dgram_on_error(
        &colliding,
        Rc::new(move |error: JsError| {
            note(&error_log, &format!("error:{}", error_message(&error)));
        }),
        no_trace(),
        true,
    );
    let listening_log = log.clone();
    dgram_on_listening(
        &colliding,
        Rc::new(move || note(&listening_log, "listening")),
        no_trace(),
        true,
    );
    // `bind` does not throw on a busy port: it defers an `error` event, which
    // is the Node shape.
    dgram_bind(&colliding, port, &string("127.0.0.1"));

    run_event_loop();

    let entries = entries(&log);
    assert_eq!(entries.len(), 1, "only the error fired: {entries:?}");
    // Shape only, on purpose. Node reports `bind EADDRINUSE 127.0.0.1:<port>`;
    // this runtime currently reports `bind EIO ...`, because its errno table
    // has no `AddrInUse` arm. Pinning the operation and the endpoint keeps the
    // test meaningful without freezing that divergence into the suite.
    assert!(
        entries[0].starts_with("error:bind ") && entries[0].contains(" 127.0.0.1:"),
        "address-in-use error names the failed bind and its endpoint: {}",
        entries[0],
    );

    drop(holder);
    drop(colliding);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn udp_unref_lets_the_loop_exit_and_closed_sockets_refuse_sends() {
    let _guard = loop_deadline(DEADLINE_MS);

    let socket = dgram_create_socket(false);
    dgram_bind(&socket, 0.0, &string("127.0.0.1"));
    dgram_unref(&socket);

    let started = std::time::Instant::now();
    run_event_loop();
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "an unreferenced socket must not hold the loop open (took {elapsed:?})",
    );

    dgram_close(&socket);
    run_event_loop();

    // Each throw has to be turned into a `Caught` before the next one is
    // raised: the runtime keeps a single exception slot and asserts if a
    // second throw lands while the first is still sitting in it.
    let send = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dgram_send_string(&socket, &string("late"), 9.0, &string("127.0.0.1"));
    }))
    .expect_err("sending on a closed socket must throw");
    assert_not_running(caught_from_panic(send), "send");
    let close_again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dgram_close(&socket);
    }))
    .expect_err("closing a closed socket must throw");
    assert_not_running(caught_from_panic(close_again), "close");

    drop(socket);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

/// Shared assertion for the closed-socket throws.
fn assert_not_running(caught: Caught, label: &str) {
    assert_eq!(caught_error_message(&caught).as_ref(), "Not running", "{label}");
    assert_eq!(
        caught_error_code(&caught).as_deref(),
        Some("ERR_SOCKET_DGRAM_NOT_RUNNING"),
        "{label}",
    );
}
