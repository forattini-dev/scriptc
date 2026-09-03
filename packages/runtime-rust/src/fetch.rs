// The static Fetch API is a thin Web-shaped layer over the native HTTP
// client. Responses reuse the incoming-message handle: it already owns the
// response head, buffers unread bytes, and participates in heap tracing.

pub fn fetch_response_new_text(body: &JsString) -> JsHttpRequest {
    Gc::new(HttpRequestData {
        fetch_response: true,
        fetch_body_used: false,
        socket: None,
        method: empty_string(),
        url: empty_string(),
        http10: false,
        status_code: Some(200.0),
        status_message: Some(empty_string()),
        headers: Vec::new(),
        body: body.as_bytes().to_vec(),
        ended: false,
        aborted: false,
        destroyed: false,
        close_emitted: false,
        finish_pending: true,
        paused: false,
        flowing: false,
        encoding_utf8: false,
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        aborted_listeners: Vec::new(),
        close_listeners: Vec::new(),
    })
}

pub fn fetch_start(
    url: &JsString,
    method: &JsString,
    headers: &JsArray<JsString>,
    body: Option<&JsString>,
) -> JsPromise<JsHttpRequest> {
    let result = promise_new();
    let setup_guard = result.clone();
    let setup_target = result.clone();
    let url = url.clone();
    let method = method.clone();
    let headers = headers.clone();
    let body = body.cloned();
    promise_run_segment(&setup_guard, move || {
        let (host, port, path) = http_client_url_parts(&url, false);
        let request = http_client_new(
            &host,
            port,
            &path,
            &method,
            false,
            0.0,
            &headers,
            false,
            true,
            &empty_string(),
            None,
        );

        let fulfilled = setup_target.clone();
        let fulfilled_trace = setup_target.clone();
        let response_url = url.clone();
        http_client_on_response(
            &request,
            Rc::new(move |response| {
                http_request_mark_fetch_response(&response, &response_url);
                let _ = promise_fulfill(&fulfilled, response);
            }),
            Rc::new(move |tracer| tracer.edge(&fulfilled_trace)),
            true,
        );

        let rejected = setup_target.clone();
        let rejected_trace = setup_target.clone();
        http_client_on_error(
            &request,
            Rc::new(move |error| {
                let _ = promise_reject(&rejected, caught_value(error));
            }),
            Rc::new(move |tracer| tracer.edge(&rejected_trace)),
            true,
        );
        if let Some(body) = body {
            http_client_write_str(&request, &body);
        }
        http_client_end(&request);
    });
    result
}

pub fn fetch_response_bytes(response: &JsHttpRequest) -> JsPromise<JsBytes<u8>> {
    if !http_request_claim_fetch_body(response) {
        return promise_rejected(caught_value(error_new(
            "TypeError",
            string("Body is unusable: Body has already been read"),
        )));
    }
    let result = promise_new();
    if response.with(|response| response.ended) {
        let _ = promise_fulfill(&result, bytes_from_elements(Vec::new()));
        return result;
    }

    let body = Rc::new(RefCell::new(Vec::new()));
    let body_at_end = body.clone();
    let fulfilled = result.clone();
    let fulfilled_trace = result.clone();
    http_request_on_end(
        response,
        Rc::new(move || {
            let bytes = bytes_from_elements(std::mem::take(&mut *body_at_end.borrow_mut()));
            let _ = promise_fulfill(&fulfilled, bytes);
        }),
        Rc::new(move |tracer| tracer.edge(&fulfilled_trace)),
        true,
    );

    http_request_on_data(
        response,
        Rc::new(move |chunk, _encoding_utf8| body.borrow_mut().extend(bytes_u8_values(&chunk))),
        Rc::new(|_| {}),
        false,
    );
    result
}

pub fn fetch_response_text(response: &JsHttpRequest) -> JsPromise<JsString> {
    let bytes = fetch_response_bytes(response);
    promise_map(&bytes, |bytes| bytes_to_string(&bytes, &string("utf8")))
}

pub fn fetch_response_header(response: &JsHttpRequest, name: &JsString) -> Option<JsString> {
    let lower = name.to_ascii_lowercase();
    http_request_headers(response)
        .into_iter()
        .find(|(header, _)| header.as_ref() == lower)
        .map(|(_, value)| value)
}

pub fn fetch_response_set_cookies(response: &JsHttpRequest) -> Vec<JsString> {
    http_request_headers(response)
        .into_iter()
        .filter_map(|(name, value)| (name.as_ref() == "set-cookie").then_some(value))
        .collect()
}
