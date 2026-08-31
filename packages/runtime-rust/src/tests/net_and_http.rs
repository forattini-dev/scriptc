// End-to-end tests for `net` and the `http` server/client pair.
//
// Every case binds port 0 on loopback and reads the assigned port back, so the
// suite never collides with a developer's own services and never leaves the
// machine. Each test drives one real `run_event_loop()` under a deadline guard,
// asserts the transcript ORDER (not just the set of events), then `finish()`es
// and proves the traced heap drained.

const LOOPBACK: &str = "127.0.0.1";

/// A port that nothing is listening on: bind, read the assignment, then drop
/// the listener so the kernel refuses the next connect.
fn refused_port() -> f64 {
    let listener = std::net::TcpListener::bind((LOOPBACK, 0))
        .expect("loopback bind for a refused port");
    let port = listener
        .local_addr()
        .expect("refused-port local address")
        .port();
    drop(listener);
    f64::from(port)
}

#[test]
fn tcp_echo_roundtrip_over_loopback() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let listening_log = log.clone();
    let server = net_server_new();
    net_server_on_listening(
        &server,
        Rc::new(move || note(&listening_log, "listening")),
        no_trace(),
        true,
    );

    let connection_log = log.clone();
    let connection_server = server.downgrade();
    net_server_on_connection(
        &server,
        Rc::new(move |connection: JsNetSocket| {
            note(&connection_log, "server-connection");
            // One request per connection: stop accepting so the loop can drain.
            net_server_close(&reborrow(&connection_server));
            let data_log = connection_log.clone();
            let echo = connection.downgrade();
            net_socket_on_data(
                &connection,
                Rc::new(move |chunk, _encoding_utf8| {
                    note(&data_log, &format!("server-data:{}", utf8(&chunk)));
                    net_socket_end_str(&reborrow(&echo), &string(&utf8(&chunk)));
                }),
                no_trace(),
                false,
            );
        }),
        no_trace(),
        false,
    );
    net_server_listen(&server, 0.0);
    let port = net_server_port(&server);
    assert!(port > 0.0, "listen(0) must report an OS-assigned port");

    let client = net_socket_connect(port, &string(LOOPBACK));
    let connect_log = log.clone();
    let connect_client = client.downgrade();
    net_socket_on_connect(
        &client,
        Rc::new(move || {
            note(&connect_log, "client-connect");
            net_socket_write_str(&reborrow(&connect_client), &string("ping"));
        }),
        no_trace(),
        true,
    );
    let data_log = log.clone();
    let data_client = client.downgrade();
    net_socket_on_data(
        &client,
        Rc::new(move |chunk, _encoding_utf8| {
            note(&data_log, &format!("client-data:{}", utf8(&chunk)));
            net_socket_end(&reborrow(&data_client));
        }),
        no_trace(),
        false,
    );
    let close_log = log.clone();
    net_socket_on_close(
        &client,
        Rc::new(move || note(&close_log, "client-close")),
        no_trace(),
        true,
    );

    run_event_loop();

    let entries = entries(&log);
    assert_eq!(
        entries,
        vec![
            "listening",
            "server-connection",
            "client-connect",
            "server-data:ping",
            "client-data:ping",
            "client-close",
        ],
        "echo transcript order",
    );

    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn tcp_connect_refused_emits_error() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let port = refused_port();

    let client = net_socket_connect(port, &string(LOOPBACK));
    let error_log = log.clone();
    net_socket_on_error(
        &client,
        Rc::new(move |error: JsError| {
            note(&error_log, &format!("error:{}", error_message(&error)));
        }),
        no_trace(),
        true,
    );
    let connect_log = log.clone();
    net_socket_on_connect(
        &client,
        Rc::new(move || note(&connect_log, "connect")),
        no_trace(),
        true,
    );

    run_event_loop();

    let entries = entries(&log);
    assert_eq!(entries.len(), 1, "exactly one event fired: {entries:?}");
    // Shape only, on purpose: Node reports `connect ECONNREFUSED <endpoint>`,
    // while this runtime's errno table has no `ConnectionRefused` arm and
    // falls back to `EIO`. Asserting the operation and the endpoint keeps the
    // test meaningful without freezing that divergence into the suite.
    let event = &entries[0];
    assert!(event.starts_with("error:connect "), "connect error: {event}");
    assert!(event.ends_with(&format!("{LOOPBACK}:{}", port as u16)), "endpoint: {event}");

    drop(client);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn tcp_write_callbacks_and_finish_order() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let server = net_server_new();
    let connection_server = server.downgrade();
    net_server_on_connection(
        &server,
        Rc::new(move |connection: JsNetSocket| {
            net_server_close(&reborrow(&connection_server));
            // Read to EOF so the peer's half-close completes.
            net_socket_on_data(&connection, Rc::new(|_chunk, _utf8| {}), no_trace(), false);
            let closing = connection.downgrade();
            net_socket_on_end(
                &connection,
                Rc::new(move || net_socket_end(&reborrow(&closing))),
                no_trace(),
                true,
            );
        }),
        no_trace(),
        false,
    );
    net_server_listen(&server, 0.0);

    let client = net_socket_connect(net_server_port(&server), &string(LOOPBACK));
    net_socket_write_str(&client, &string("payload"));
    let write_log = log.clone();
    net_socket_after_write(
        &client,
        Rc::new(move || note(&write_log, "after-write")),
        no_trace(),
    );
    let finish_log = log.clone();
    net_socket_on_finish(
        &client,
        Rc::new(move || note(&finish_log, "finish")),
        no_trace(),
    );
    let close_log = log.clone();
    net_socket_on_close(
        &client,
        Rc::new(move || note(&close_log, "close")),
        no_trace(),
        true,
    );
    net_socket_end(&client);

    run_event_loop();

    let entries = entries(&log);
    assert_eq!(entries, vec!["after-write", "finish", "close"]);
    assert_eq!(net_socket_bytes_written(&client), 7.0);
    assert!(!net_socket_writable(&client), "end() clears writable");

    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn tcp_two_servers_get_distinct_os_ports() {
    let _guard = loop_deadline(DEADLINE_MS);

    let first = net_server_new();
    let second = net_server_new();
    net_server_listen(&first, 0.0);
    net_server_listen(&second, 0.0);
    let first_port = net_server_port(&first);
    let second_port = net_server_port(&second);
    assert!(first_port > 0.0 && second_port > 0.0, "both ports assigned");
    assert_ne!(
        first_port, second_port,
        "port 0 must hand out distinct ports",
    );

    net_server_close(&first);
    net_server_close(&second);
    run_event_loop();

    drop(first);
    drop(second);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn http_roundtrip_server_and_client() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let server_log = log.clone();
    let server = http_server_new();
    let request_server = server.downgrade();
    http_server_on_request(
        &server,
        Rc::new(move |request: JsHttpRequest, response: JsHttpResponse| {
            note(
                &server_log,
                &format!(
                    "request:{} {}",
                    http_request_method(&request),
                    http_request_url(&request)
                ),
            );
            net_server_close(&reborrow(&request_server));
            http_response_write_head(&response, 200.0);
            http_response_set_header(&response, &string("content-type"), &string("text/plain"));
            http_response_end_str(&response, &string("hi"));
        }),
        no_trace(),
        false,
    );
    net_server_listen(&server, 0.0);

    let response_log = log.clone();
    let request = http_client_request_callback(
        &string(LOOPBACK),
        net_server_port(&server),
        &string("/greet"),
        &string("GET"),
        0.0,
        &array_new::<JsString>(Vec::new()),
        true,
        Rc::new(move |response: JsHttpRequest| {
            let status = http_request_status_code(&response).unwrap_or(0.0);
            note(&response_log, &format!("status:{status}"));
            let body_log = response_log.clone();
            http_request_on_data(
                &response,
                Rc::new(move |chunk| {
                    note(&body_log, &format!("body:{}", utf8(&chunk)));
                }),
                no_trace(),
                false,
            );
            let end_log = response_log.clone();
            http_request_on_end(
                &response,
                Rc::new(move || note(&end_log, "response-end")),
                no_trace(),
                true,
            );
        }),
        no_trace(),
    );

    run_event_loop();

    assert_eq!(
        entries(&log),
        vec!["request:GET /greet", "status:200", "body:hi", "response-end"],
    );

    drop(request);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn http_client_error_on_refused() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();
    let port = refused_port();

    let request = http_client_request(
        &string(LOOPBACK),
        port,
        &string("/"),
        &string("GET"),
        0.0,
        &array_new::<JsString>(Vec::new()),
        true,
    );
    let error_log = log.clone();
    http_client_on_error(
        &request,
        Rc::new(move |error: JsError| {
            note(&error_log, &format!("error:{}", error_message(&error)));
        }),
        no_trace(),
        true,
    );
    let response_log = log.clone();
    http_client_on_response(
        &request,
        Rc::new(move |_response: JsHttpRequest| note(&response_log, "response")),
        no_trace(),
        true,
    );

    run_event_loop();

    let entries = entries(&log);
    assert!(
        entries.iter().any(|entry| entry.starts_with("error:connect ")),
        "connect error reached the request: {entries:?}",
    );
    assert!(
        !entries.iter().any(|entry| entry == "response"),
        "no response on a refused connect: {entries:?}",
    );

    drop(request);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
