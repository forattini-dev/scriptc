// HTTP/1.1 request framing: the shared chunked decoder, request-head body
// framing plus the keep-alive decision, and one live server round-trip that
// exercises a chunked body, a pipelined follow-up request, and the
// HTTP/1.1 keep-alive default over a single socket.

fn chunk_step(buffer: &mut Vec<u8>, remaining: &mut Option<usize>, limit: usize) -> String {
    match http_chunked_step(buffer, remaining, limit) {
        HttpChunkStep::NeedMore => "need-more".to_string(),
        HttpChunkStep::Data(body) => format!("data:{}", String::from_utf8_lossy(&body)),
        HttpChunkStep::Done => "done".to_string(),
        HttpChunkStep::Bad => "bad".to_string(),
    }
}

#[test]
fn chunked_decoder_reads_chunks_extensions_and_terminator() {
    let mut buffer = b"4\r\nWiki\r\n5;ext=zero\r\npedia\r\n0\r\n\r\n".to_vec();
    let mut remaining = None;
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "data:Wiki");
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "data:pedia");
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "done");
    assert!(buffer.is_empty(), "terminator drains the trailing CRLF");
}

#[test]
fn chunked_decoder_resumes_across_feeds() {
    let mut buffer = b"4\r".to_vec();
    let mut remaining = None;
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "need-more");
    buffer.extend_from_slice(b"\nWi");
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "need-more");
    assert_eq!(remaining, Some(4), "the size line is consumed once it is whole");
    buffer.extend_from_slice(b"ki\r\n");
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "data:Wiki");
    assert_eq!(remaining, None);
}

#[test]
fn chunked_decoder_rejects_a_bad_size_line() {
    let mut buffer = b"zz\r\nnope\r\n".to_vec();
    let mut remaining = None;
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "bad");
}

#[test]
fn chunked_decoder_rejects_an_unbounded_size_line() {
    let mut buffer = vec![b'a'; 65];
    let mut remaining = None;
    assert_eq!(chunk_step(&mut buffer, &mut remaining, 64), "bad");
    let mut short = vec![b'a'; 8];
    assert_eq!(chunk_step(&mut short, &mut remaining, 64), "need-more");
}

fn head_framing(bytes: &[u8]) -> String {
    let Some(head) = http_parse_request_head(bytes) else {
        return "unparsed".to_string();
    };
    let framing = match head.framing {
        HttpBodyFraming::Length(length) => format!("length:{length}"),
        HttpBodyFraming::Chunked => "chunked".to_string(),
        HttpBodyFraming::Invalid => "invalid".to_string(),
    };
    format!("{framing} keep-alive:{}", head.keep_alive)
}

#[test]
fn request_head_reports_body_framing_and_keep_alive() {
    assert_eq!(
        head_framing(b"GET /a HTTP/1.1\r\nHost: t\r\n\r\n"),
        "length:0 keep-alive:true",
        "HTTP/1.1 defaults to a kept-alive connection",
    );
    assert_eq!(
        head_framing(b"GET /a HTTP/1.0\r\nHost: t\r\n\r\n"),
        "length:0 keep-alive:false",
        "HTTP/1.0 defaults to closing",
    );
    assert_eq!(
        head_framing(b"GET /a HTTP/1.0\r\nConnection: keep-alive\r\n\r\n"),
        "length:0 keep-alive:true",
    );
    assert_eq!(
        head_framing(b"GET /a HTTP/1.1\r\nConnection: close\r\n\r\n"),
        "length:0 keep-alive:false",
    );
    assert_eq!(
        head_framing(b"POST /a HTTP/1.1\r\nContent-Length: 7\r\n\r\n"),
        "length:7 keep-alive:true",
    );
    assert_eq!(
        head_framing(b"POST /a HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n"),
        "chunked keep-alive:true",
    );
    assert_eq!(
        head_framing(b"POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n"),
        "invalid keep-alive:true",
        "a body framed twice is a request smuggling vector, never a body",
    );
}

#[test]
fn http_server_decodes_chunked_and_pipelined_requests() {
    let _guard = loop_deadline(DEADLINE_MS);
    let log = transcript();

    let server = http_server_new();
    let request_server = server.downgrade();
    let server_log = log.clone();
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
            // One connection carries both requests, so stop accepting.
            net_server_close(&reborrow(&request_server));
            let body = Rc::new(RefCell::new(String::new()));
            let data_body = body.clone();
            http_request_on_data(
                &request,
                Rc::new(move |chunk, _encoding_utf8| data_body.borrow_mut().push_str(&utf8(&chunk))),
                no_trace(),
                false,
            );
            let end_log = server_log.clone();
            let end_response = response.clone();
            http_request_on_end(
                &request,
                Rc::new(move || {
                    note(&end_log, &format!("body:{}", body.borrow()));
                    http_response_end_str(&end_response, &string("ok"));
                }),
                no_trace(),
                true,
            );
        }),
        no_trace(),
        false,
    );
    net_server_listen(&server, 0.0);
    let port = net_server_port(&server);

    let client = net_socket_connect(port, &string(LOOPBACK));
    let connect_client = client.downgrade();
    net_socket_on_connect(
        &client,
        Rc::new(move || {
            // Both requests ride one TCP segment; the first keeps the
            // connection alive, the second closes it.
            net_socket_write_str(
                &reborrow(&connect_client),
                &string(concat!(
                    "POST /upload HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n",
                    "4\r\nWiki\r\n5;ext=zero\r\npedia\r\n0\r\n\r\n",
                    "GET /next HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
                )),
            );
        }),
        no_trace(),
        true,
    );
    let raw = Rc::new(RefCell::new(String::new()));
    let data_raw = raw.clone();
    net_socket_on_data(
        &client,
        Rc::new(move |chunk, _encoding_utf8| data_raw.borrow_mut().push_str(&utf8(&chunk))),
        no_trace(),
        false,
    );
    let end_log = log.clone();
    net_socket_on_end(
        &client,
        Rc::new(move || {
            let text = raw.borrow();
            note(&end_log, &format!("responses:{}", text.matches("HTTP/1.1 200").count()));
            note(&end_log, &format!("kept-alive:{}", text.contains("Connection: keep-alive")));
            note(&end_log, &format!("closed:{}", text.contains("Connection: close")));
        }),
        no_trace(),
        true,
    );

    run_event_loop();

    assert_eq!(
        entries(&log),
        vec![
            "request:POST /upload",
            "body:Wikipedia",
            "request:GET /next",
            "body:",
            "responses:2",
            "kept-alive:true",
            "closed:true",
        ],
        "chunked body, pipelined follow-up, and the keep-alive disposition",
    );

    drop(client);
    drop(server);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
