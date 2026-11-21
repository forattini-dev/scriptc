#[test]
fn tcp_accept_ready_between_poll_and_connect_completion() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let server = net_server_new();
    let connection_log = log.clone();
    net_server_on_connection(
        &server,
        Rc::new(move |connection| {
            note(&connection_log, "server-connection");
            net_socket_destroy(&connection);
        }),
        no_trace(),
        true,
    );
    net_server_listen(&server, 0.0);
    assert!(net_dispatch_one(), "dispatch the listening notification");
    assert!(!net_accept_one(), "initial accept poll has no connection");

    let port = net_server_port(&server);
    let client = net_socket_connect_deferred(port, &string(LOOPBACK));
    let connect_log = log.clone();
    net_socket_on_connect(
        &client,
        Rc::new(move || note(&connect_log, "client-connect")),
        no_trace(),
        true,
    );
    // Complete the worker's handshake after the accept poll, without relying
    // on thread scheduling or sleeps to hit the readiness-check race.
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port as u16));
    let stream = std::net::TcpStream::connect_timeout(
        &address,
        std::time::Duration::from_secs(2),
    ).expect("loopback handshake");
    let (sender, receiver) = std::sync::mpsc::channel();
    sender
        .send(Ok(NetStream::Tcp(stream)))
        .expect("connect completion receiver");
    client.with_mut(|socket| {
        socket.pending_connect = None;
        socket.connect_rx = Some(receiver);
    });
    assert!(net_socket_connect_one(), "observe the completed handshake");
    assert!(net_dispatch_one(), "dispatch the connect notification");
    assert_eq!(entries(&log), vec!["server-connection", "client-connect"]);

    net_socket_destroy(&client);
    net_server_close(&server);
    run_event_loop();
    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn disconnected_socket_does_not_keep_the_event_loop_alive() {
    let socket = net_socket_new();
    assert!(!net_socket_destroyed(&socket));
    assert!(net_socket_readable(&socket));
    assert!(net_socket_writable(&socket));
    assert!(!loop_net_pending());
    run_event_loop();
    assert!(!net_socket_destroyed(&socket));
    net_socket_destroy(&socket);
    run_event_loop();
    drop(socket);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn disconnected_socket_connects_without_changing_identity_or_listeners() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let server = net_server_new();
    let server_ref = server.downgrade();
    let server_log = log.clone();
    net_server_on_connection(
        &server,
        Rc::new(move |connection| {
            note(&server_log, "server-connection");
            net_socket_destroy(&connection);
            net_server_close(&reborrow(&server_ref));
        }),
        no_trace(),
        true,
    );
    net_server_listen(&server, 0.0);
    let client = net_socket_new();
    let client_ref = client.downgrade();
    let client_log = log.clone();
    net_socket_on_connect(
        &client,
        Rc::new(move || {
            note(&client_log, "client-connect");
            net_socket_destroy(&reborrow(&client_ref));
        }),
        no_trace(),
        true,
    );
    let returned = net_socket_connect_existing(&client, net_server_port(&server), &string(LOOPBACK));
    assert!(returned.ptr_eq(&client));
    run_event_loop();
    assert_eq!(entries(&log), vec!["server-connection", "client-connect"]);
    drop(returned);
    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn idle_socket_timeout_is_unreferenced_and_does_not_destroy() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let socket = net_socket_new();
    let timeout_log = log.clone();
    let timeout_socket = socket.downgrade();
    net_socket_on_timeout(
        &socket,
        Rc::new(move || {
            assert!(!net_socket_destroyed(&reborrow(&timeout_socket)));
            note(&timeout_log, "timeout");
        }),
        no_trace(),
        true,
    );
    assert!(net_socket_set_timeout(&socket, 10.0).ptr_eq(&socket));
    assert_eq!(net_socket_timeout(&socket), Some(10.0));
    run_event_loop();
    assert!(entries(&log).is_empty(), "idle timeout must not keep the loop alive");
    let final_log = log.clone();
    timer_set_timeout(Box::new(move || note(&final_log, "other timer")), 50.0);
    run_event_loop();
    assert_eq!(entries(&log), vec!["timeout", "other timer"]);
    assert!(!net_socket_destroyed(&socket));
    net_socket_destroy(&socket);
    run_event_loop();
    drop(socket);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn socket_timeout_refresh_and_disable_preserve_listener_state() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let socket = net_socket_new();
    let timeout_log = log.clone();
    net_socket_on_timeout(
        &socket,
        Rc::new(move || note(&timeout_log, "timeout")),
        no_trace(),
        false,
    );
    net_socket_set_timeout(&socket, 100.0);
    let weak = socket.downgrade();
    let touch_log = log.clone();
    timer_set_timeout(
        Box::new(move || {
            note(&touch_log, "activity");
            net_socket_touch(&reborrow(&weak));
        }),
        20.0,
    );
    let middle_log = log.clone();
    timer_set_timeout(Box::new(move || note(&middle_log, "middle")), 60.0);
    let end_log = log.clone();
    timer_set_timeout(Box::new(move || note(&end_log, "end")), 200.0);
    run_event_loop();
    assert_eq!(entries(&log), vec!["activity", "middle", "timeout", "end"]);
    net_socket_set_timeout(&socket, 10.0);
    net_socket_set_timeout(&socket, 0.0);
    assert_eq!(net_socket_timeout(&socket), Some(0.0));
    let final_log = log.clone();
    timer_set_timeout(Box::new(move || note(&final_log, "disabled")), 25.0);
    run_event_loop();
    assert_eq!(entries(&log), vec!["activity", "middle", "timeout", "end", "disabled"]);
    net_socket_destroy(&socket);
    run_event_loop();
    drop(socket);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn socket_timeout_restarts_after_incoming_tcp_data() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let server = net_server_new();
    let server_ref = server.downgrade();
    net_server_on_connection(
        &server,
        Rc::new(move |peer| {
            net_server_close(&reborrow(&server_ref));
            let peer = peer.downgrade();
            let peer_for_close = peer.clone();
            timer_set_timeout(
                Box::new(move || net_socket_write_str(&reborrow(&peer), &string("x"))),
                60.0,
            );
            timer_set_timeout(
                Box::new(move || net_socket_destroy(&reborrow(&peer_for_close))),
                400.0,
            );
        }),
        no_trace(),
        true,
    );
    net_server_listen(&server, 0.0);
    let client = net_socket_new();
    let data_log = log.clone();
    net_socket_on_data(
        &client,
        Rc::new(move |chunk, _| {
            note(&data_log, &format!("data:{}", utf8(&chunk)));
            let middle_log = data_log.clone();
            timer_set_timeout(Box::new(move || note(&middle_log, "middle")), 160.0);
        }),
        no_trace(),
        true,
    );
    let timeout_log = log.clone();
    let client_ref = client.downgrade();
    net_socket_on_timeout(
        &client,
        Rc::new(move || {
            note(&timeout_log, "timeout");
            net_socket_destroy(&reborrow(&client_ref));
        }),
        no_trace(),
        true,
    );
    net_socket_set_timeout(&client, 200.0);
    net_socket_connect_existing(&client, net_server_port(&server), &string(LOOPBACK));
    run_event_loop();
    assert_eq!(entries(&log), vec!["data:x", "middle", "timeout"]);
    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn destroying_a_socket_cancels_its_timeout() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let socket = net_socket_new();
    let timeout_log = log.clone();
    net_socket_on_timeout(
        &socket,
        Rc::new(move || note(&timeout_log, "timeout")),
        no_trace(),
        true,
    );
    net_socket_set_timeout(&socket, 10.0);
    net_socket_destroy(&socket);
    let end_log = log.clone();
    timer_set_timeout(Box::new(move || note(&end_log, "end")), 35.0);
    run_event_loop();
    assert_eq!(entries(&log), vec!["end"]);
    drop(socket);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
