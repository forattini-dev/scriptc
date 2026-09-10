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
    sender.send(Ok(stream)).expect("connect completion receiver");
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
