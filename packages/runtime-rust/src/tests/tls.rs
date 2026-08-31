// End-to-end tests for `tls` and `https`.
//
// The certificates are committed fixtures with ~100-year validity (see
// `certs/README.md`), so these tests never touch a system trust store and
// never depend on the clock. Every case runs a real handshake between an
// in-process server and an in-process client over loopback: the positive ones
// prove the trust plumbing accepts what it should, the negative ones prove it
// reports the Node error CODE and message, and still lets the loop drain.

const CA_PEM: &str = include_str!("certs/ca.pem");
/// A trust anchor that signed nothing here — the wrong-issuer fixture.
const CA2_PEM: &str = include_str!("certs/ca2.pem");
const LOCALHOST_CERT_PEM: &str = include_str!("certs/localhost.pem");
const LOCALHOST_KEY_PEM: &str = include_str!("certs/localhost-key.pem");
const SELFSIGNED_CERT_PEM: &str = include_str!("certs/selfsigned.pem");
const SELFSIGNED_KEY_PEM: &str = include_str!("certs/selfsigned-key.pem");

/// The leaf's SAN covers `localhost`, `127.0.0.1` and `::1`; the tests connect
/// to the loopback address and present `localhost` as the SNI name.
const SNI: &str = "localhost";

#[test]
fn tls_echo_roundtrip_with_custom_ca() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let entries = echo_once(
        LOCALHOST_CERT_PEM,
        LOCALHOST_KEY_PEM,
        Some(string(CA_PEM)),
        true,
        &log,
    );

    // The client completes its side of a TLS 1.3 handshake first — it may
    // write application data immediately after sending `Finished`, while the
    // server only reports `secureConnection` once that flight arrives.
    assert_eq!(
        entries,
        vec![
            "client-secure:true:none",
            "server-secure",
            "server-data:ping",
            "client-data:pong",
            "client-close",
        ],
    );
}

#[test]
fn tls_rejects_unknown_issuer() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let server = tls_server_new(&string(LOCALHOST_CERT_PEM), &string(LOCALHOST_KEY_PEM));
    net_server_listen(&server, 0.0);

    // The client trusts a CA that signed nothing in this exchange.
    let client = tls_socket_connect(
        net_server_port(&server),
        &string("127.0.0.1"),
        &string(SNI),
        true,
        Some(string(CA2_PEM)),
    );
    let secure_log = log.clone();
    tls_socket_on_secure_connect(
        &client,
        Rc::new(move || note(&secure_log, "secure")),
        no_trace(),
        true,
    );
    let error_log = log.clone();
    let error_server = server.downgrade();
    net_socket_on_error(
        &client,
        Rc::new(move |error: JsError| {
            note(&error_log, &format!("error:{}", error_message(&error)));
            net_server_close(&reborrow(&error_server));
        }),
        no_trace(),
        true,
    );

    run_event_loop();

    let entries = entries(&log);
    assert!(
        !entries.iter().any(|entry| entry == "secure"),
        "a rejected handshake never reports secureConnect: {entries:?}",
    );
    let error = entries
        .iter()
        .find(|entry| entry.starts_with("error:"))
        .unwrap_or_else(|| panic!("the client reported no error: {entries:?}"));
    assert!(
        error.contains("unable to verify the first certificate"),
        "unknown-issuer message: {error}",
    );
    assert!(!tls_socket_authorized(&client));

    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn tls_unauthorized_but_permitted() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    // Same wrong anchor as above, but the client opts out of rejection: the
    // handshake completes, `authorized` is false, and the reason is readable.
    let entries = echo_once(
        LOCALHOST_CERT_PEM,
        LOCALHOST_KEY_PEM,
        Some(string(CA2_PEM)),
        false,
        &log,
    );

    assert_eq!(
        entries,
        vec![
            "client-secure:false:UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            "server-secure",
            "server-data:ping",
            "client-data:pong",
            "client-close",
        ],
    );
}

#[test]
fn tls_selfsigned_reports_depth_zero_code() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let server = tls_server_new(&string(SELFSIGNED_CERT_PEM), &string(SELFSIGNED_KEY_PEM));
    net_server_listen(&server, 0.0);

    // No `ca`: the default trust store, which of course has never heard of a
    // freshly minted self-signed leaf.
    let client = tls_socket_connect(
        net_server_port(&server),
        &string("127.0.0.1"),
        &string(SNI),
        false,
        None,
    );
    let secure_log = log.clone();
    let inspecting = client.downgrade();
    let secure_server = server.downgrade();
    tls_socket_on_secure_connect(
        &client,
        Rc::new(move || {
            let client = reborrow(&inspecting);
            note(
                &secure_log,
                &format!(
                    "secure:{}:{}",
                    tls_socket_authorized(&client),
                    tls_socket_authorization_error(&client)
                        .map_or_else(|| "none".to_owned(), |code| code.to_string()),
                ),
            );
            net_server_close(&reborrow(&secure_server));
            net_socket_end(&client);
        }),
        no_trace(),
        true,
    );
    record_no_error(&client, &log);

    run_event_loop();

    assert_eq!(
        entries(&log),
        vec!["secure:false:DEPTH_ZERO_SELF_SIGNED_CERT"],
    );

    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn tls_default_ca_store_injection() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    // Replacing the default store is the `--use-openssl-ca`-shaped knob: after
    // it, a client that passes no `ca` still trusts the fixture chain.
    tls_ca_set_default(&array_new(vec![string(CA_PEM)]));

    let entries = echo_once(LOCALHOST_CERT_PEM, LOCALHOST_KEY_PEM, None, true, &log);

    assert_eq!(
        entries,
        vec![
            "client-secure:true:none",
            "server-secure",
            "server-data:ping",
            "client-data:pong",
            "client-close",
        ],
    );
    // `echo_once` ends with `finish()`, which restores the bundled default.
    assert!(
        array_len(&tls_ca_get(&string("default"))) > 1.0,
        "finish() restores the bundled default store",
    );
}

#[test]
fn https_worker_client_roundtrip() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let server_log = log.clone();
    let request_server: Rc<RefCell<Option<GcWeak<NetServerData>>>> = Rc::new(RefCell::new(None));
    let closing_server = request_server.clone();
    let server = https_server_new_callback(
        &string(LOCALHOST_CERT_PEM),
        &string(LOCALHOST_KEY_PEM),
        Rc::new(move |request: JsHttpRequest, response: JsHttpResponse| {
            note(&server_log, &format!("request:{}", http_request_url(&request)));
            if let Some(server) = closing_server.borrow().as_ref() {
                net_server_close(&reborrow(server));
            }
            http_response_write_head(&response, 200.0);
            http_response_end_str(&response, &string("secure hi"));
        }),
        no_trace(),
    );
    // The listener is registered by the constructor, so the handler learns
    // which server to close only once that server exists.
    *request_server.borrow_mut() = Some(server.downgrade());
    net_server_listen(&server, 0.0);

    // The https client runs the exchange on a worker thread and hands the
    // response back through `http_tls_dispatch_one`, so this single
    // `run_event_loop()` has to serve the request AND collect the reply.
    // `host` doubles as the SNI name, which is why it is `localhost` and not
    // the dotted address the server bound.
    let response_log = log.clone();
    let request = https_client_request_callback(
        &string(SNI),
        net_server_port(&server),
        &string("/secure"),
        &string("GET"),
        0.0,
        &array_new::<JsString>(Vec::new()),
        true,
        true,
        &string(CA_PEM),
        Rc::new(move |response: JsHttpRequest| {
            note(
                &response_log,
                &format!("status:{}", http_request_status_code(&response).unwrap_or(0.0)),
            );
            let body_log = response_log.clone();
            http_request_on_data(
                &response,
                Rc::new(move |chunk| note(&body_log, &format!("body:{}", utf8(&chunk)))),
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
    let error_log = log.clone();
    http_client_on_error(
        &request,
        Rc::new(move |error: JsError| {
            note(&error_log, &format!("error:{}", error_message(&error)));
        }),
        no_trace(),
        true,
    );

    run_event_loop();

    assert_eq!(
        entries(&log),
        vec![
            "request:/secure",
            "status:200",
            "body:secure hi",
            "response-end",
        ],
    );

    drop(request);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn tls_close_notify_clean_shutdown() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let server = tls_server_new(&string(LOCALHOST_CERT_PEM), &string(LOCALHOST_KEY_PEM));
    let secure_log = log.clone();
    let secure_server = server.downgrade();
    tls_server_on_secure_connection(
        &server,
        Rc::new(move |connection: JsNetSocket| {
            net_server_close(&reborrow(&secure_server));
            let end_log = secure_log.clone();
            let ending = connection.downgrade();
            // `end` here is the peer's close_notify arriving, not a reset.
            net_socket_on_end(
                &connection,
                Rc::new(move || {
                    note(&end_log, "server-end");
                    net_socket_end(&reborrow(&ending));
                }),
                no_trace(),
                true,
            );
            let close_log = secure_log.clone();
            net_socket_on_close(
                &connection,
                Rc::new(move || note(&close_log, "server-close")),
                no_trace(),
                true,
            );
            record_no_error(&connection, &secure_log);
        }),
        no_trace(),
        false,
    );
    net_server_listen(&server, 0.0);

    let client = tls_socket_connect(
        net_server_port(&server),
        &string("127.0.0.1"),
        &string(SNI),
        true,
        Some(string(CA_PEM)),
    );
    let closing = client.downgrade();
    tls_socket_on_secure_connect(
        &client,
        Rc::new(move || net_socket_end(&reborrow(&closing))),
        no_trace(),
        true,
    );
    let close_log = log.clone();
    net_socket_on_close(
        &client,
        Rc::new(move || note(&close_log, "client-close")),
        no_trace(),
        true,
    );
    record_no_error(&client, &log);

    run_event_loop();

    let entries = entries(&log);
    assert!(
        !entries.iter().any(|entry| entry.starts_with("error:")),
        "a close_notify shutdown raises no error: {entries:?}",
    );
    assert!(entries.contains(&"server-end".to_owned()), "{entries:?}");
    assert!(entries.contains(&"server-close".to_owned()), "{entries:?}");
    assert!(entries.contains(&"client-close".to_owned()), "{entries:?}");

    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

/// Records any socket `error` so a test can assert none was raised.
fn record_no_error(socket: &JsNetSocket, log: &Transcript) {
    let error_log = log.clone();
    net_socket_on_error(
        socket,
        Rc::new(move |error: JsError| {
            note(&error_log, &format!("error:{}", error_message(&error)));
        }),
        no_trace(),
        false,
    );
}

/// One `ping`/`pong` exchange over TLS, from listen to close.
///
/// The two positive-path variants differ only in what the client trusts, so
/// they share this body and assert on the transcript it returns. It runs the
/// whole lifecycle including `finish()` and the per-test leak check.
fn echo_once(
    cert: &str,
    key: &str,
    ca: Option<JsString>,
    reject_unauthorized: bool,
    log: &Transcript,
) -> Vec<String> {
    let server = tls_server_new(&string(cert), &string(key));
    let secure_log = log.clone();
    let secure_server = server.downgrade();
    tls_server_on_secure_connection(
        &server,
        Rc::new(move |connection: JsNetSocket| {
            note(&secure_log, "server-secure");
            net_server_close(&reborrow(&secure_server));
            let data_log = secure_log.clone();
            let echo = connection.downgrade();
            net_socket_on_data(
                &connection,
                Rc::new(move |chunk, _encoding_utf8| {
                    note(&data_log, &format!("server-data:{}", utf8(&chunk)));
                    net_socket_end_str(&reborrow(&echo), &string("pong"));
                }),
                no_trace(),
                false,
            );
        }),
        no_trace(),
        false,
    );
    net_server_listen(&server, 0.0);

    let client = tls_socket_connect(
        net_server_port(&server),
        &string("127.0.0.1"),
        &string(SNI),
        reject_unauthorized,
        ca,
    );
    let secure_log = log.clone();
    let writing = client.downgrade();
    tls_socket_on_secure_connect(
        &client,
        Rc::new(move || {
            let client = reborrow(&writing);
            // Read the verification verdict here, not after the loop: the
            // socket drops its TLS state when it is destroyed.
            assert_eq!(tls_socket_encrypted(&client), Some(true));
            note(
                &secure_log,
                &format!(
                    "client-secure:{}:{}",
                    tls_socket_authorized(&client),
                    tls_socket_authorization_error(&client)
                        .map_or_else(|| "none".to_owned(), |code| code.to_string()),
                ),
            );
            net_socket_write_str(&client, &string("ping"));
        }),
        no_trace(),
        true,
    );
    let data_log = log.clone();
    let ending = client.downgrade();
    net_socket_on_data(
        &client,
        Rc::new(move |chunk, _encoding_utf8| {
            note(&data_log, &format!("client-data:{}", utf8(&chunk)));
            net_socket_end(&reborrow(&ending));
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
    record_no_error(&client, log);

    run_event_loop();

    let entries = entries(log);

    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
    entries
}
