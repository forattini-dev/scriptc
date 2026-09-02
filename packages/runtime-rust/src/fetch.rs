// The static Fetch API is a thin Web-shaped layer over the native HTTP
// client. Responses reuse the incoming-message handle: it already owns the
// response head, buffers unread bytes, and participates in heap tracing.

pub fn fetch_start(url: &JsString) -> JsPromise<JsHttpRequest> {
    let result = promise_new();
    let setup_guard = result.clone();
    let setup_target = result.clone();
    let url = url.clone();
    promise_run_segment(&setup_guard, move || {
        let request = http_client_request_url(&url, &string("GET"), false);

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
        http_client_end(&request);
    });
    result
}

pub fn fetch_response_text(response: &JsHttpRequest) -> JsPromise<JsString> {
    let result = promise_new();
    if response.with(|response| response.ended) {
        let _ = promise_fulfill(&result, empty_string());
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
            let text = bytes_to_string(&bytes, &string("utf8"));
            let _ = promise_fulfill(&fulfilled, text);
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
