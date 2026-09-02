// The static Fetch API is a thin Web-shaped layer over the native HTTP
// client. Responses reuse the incoming-message handle: it already owns the
// response head, buffers unread bytes, and participates in heap tracing.

pub fn fetch_response_new_text(body: &JsString) -> JsHttpRequest {
    Gc::new(HttpRequestData {
        socket: None,
        method: empty_string(),
        url: empty_string(),
        status_code: Some(200.0),
        status_message: Some(empty_string()),
        headers: Vec::new(),
        body: body.as_bytes().to_vec(),
        ended: false,
        finish_pending: true,
        paused: false,
        flowing: false,
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
    })
}

pub fn fetch_start(
    url: &JsString,
    method: &JsString,
    body: Option<&JsString>,
) -> JsPromise<JsHttpRequest> {
    let result = promise_new();
    let setup_guard = result.clone();
    let setup_target = result.clone();
    let url = url.clone();
    let method = method.clone();
    let body = body.cloned();
    promise_run_segment(&setup_guard, move || {
        let request = http_client_request_url(&url, &method, false);

        let fulfilled = setup_target.clone();
        let fulfilled_trace = setup_target.clone();
        http_client_on_response(
            &request,
            Rc::new(move |response| {
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
        Rc::new(move |chunk| body.borrow_mut().extend(bytes_u8_values(&chunk))),
        Rc::new(|_| {}),
        false,
    );
    result
}

pub fn fetch_response_text(response: &JsHttpRequest) -> JsPromise<JsString> {
    let bytes = fetch_response_bytes(response);
    promise_map(&bytes, |bytes| bytes_to_string(&bytes, &string("utf8")))
}
