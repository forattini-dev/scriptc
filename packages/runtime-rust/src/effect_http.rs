// effect/unstable/http request values. The public combinators are immutable:
// every update returns a fresh kernel handle and leaves the prior request
// reusable. Transport execution is layered on this description separately.

#[derive(Clone)]
pub struct EffectHttpRequestData {
    pub method: JsString,
    pub url: JsString,
    pub url_params: Vec<(JsString, JsString)>,
    pub headers: Vec<(JsString, JsString)>,
    pub body_json: Option<JsString>,
}

fn effect_http_request_data(handle: &JsEffect) -> Rc<EffectHttpRequestData> {
    handle.with(|value| match &value.node {
        EffectNode::Data(KernelData::HttpRequest(request)) => request.clone(),
        _ => effect_unbox_mismatch("HttpClientRequest"),
    })
}

fn effect_http_request_new(data: EffectHttpRequestData) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::HttpRequest(Rc::new(data))))
}

pub fn effect_http_request_make(method: &JsString, url: &JsString) -> JsEffect {
    effect_http_request_new(EffectHttpRequestData {
        method: method.clone(),
        url: url.clone(),
        url_params: Vec::new(),
        headers: Vec::new(),
        body_json: None,
    })
}

fn set_named(entries: &mut Vec<(JsString, JsString)>, name: &JsString, value: &JsString, ascii_case_insensitive: bool) {
    entries.retain(|(current, _)| if ascii_case_insensitive {
        !current.as_ref().eq_ignore_ascii_case(name.as_ref())
    } else {
        current != name
    });
    entries.push((name.clone(), value.clone()));
}

pub fn effect_http_request_set_url_param(request: &JsEffect, name: &JsString, value: &JsString) -> JsEffect {
    let mut next = (*effect_http_request_data(request)).clone();
    set_named(&mut next.url_params, name, value, false);
    effect_http_request_new(next)
}

pub fn effect_http_request_append_url_param(request: &JsEffect, name: &JsString, value: &JsString) -> JsEffect {
    let mut next = (*effect_http_request_data(request)).clone();
    next.url_params.push((name.clone(), value.clone()));
    effect_http_request_new(next)
}

pub fn effect_http_request_set_header(request: &JsEffect, name: &JsString, value: &JsString) -> JsEffect {
    let mut next = (*effect_http_request_data(request)).clone();
    set_named(&mut next.headers, name, value, true);
    effect_http_request_new(next)
}

pub fn effect_http_request_set_headers(
    request: &JsEffect,
    headers: &JsMap<JsString, JsString>,
) -> JsEffect {
    let mut next = (*effect_http_request_data(request)).clone();
    let mut index = 0.0;
    while index < map_iter_count(headers) {
        if map_iter_live(headers, index) {
            let name = map_iter_key(headers, index);
            let value = map_iter_value(headers, index);
            set_named(&mut next.headers, &name, &value, true);
        }
        index += 1.0;
    }
    effect_http_request_new(next)
}

/// `bodyJson` defers JSON validation into the returned effect. A successful
/// effect carries the next immutable request; a serialization failure occupies
/// the ordinary typed failure channel and can be transformed by `mapError`.
pub fn effect_http_request_body_json(
    request: &JsEffect,
    body: Result<JsString, String>,
) -> JsEffect {
    match body {
        Ok(body) => {
            let mut next = (*effect_http_request_data(request)).clone();
            next.body_json = Some(body);
            effect_succeed(effect_box(effect_http_request_new(next)))
        }
        Err(message) => effect_fail(effect_box(string(&message))),
    }
}

fn effect_http_client_new() -> JsEffect {
    effect_new(EffectNode::Data(KernelData::HttpClient))
}

fn effect_http_response_new(response: JsHttpRequest) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::HttpResponse(response)))
}

fn effect_http_client_error(reason: &str) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::HttpClientError(string(reason))))
}

pub fn effect_http_client_error_reason(error: &JsEffect) -> JsEffect {
    error.with(|value| match &value.node {
        EffectNode::Data(KernelData::HttpClientError(reason)) => {
            effect_new(EffectNode::Data(KernelData::HttpClientErrorReason(reason.clone())))
        }
        _ => effect_unbox_mismatch("HttpClientError"),
    })
}

fn effect_http_response_data(handle: &JsEffect) -> JsHttpRequest {
    handle.with(|value| match &value.node {
        EffectNode::Data(KernelData::HttpResponse(response)) => response.clone(),
        _ => effect_unbox_mismatch("HttpClientResponse"),
    })
}

/// The concrete Fetch layer provides exactly the same service key exported by
/// `HttpClient.HttpClient`; custom layers remain distinct and cannot silently
/// fall back to a process-global transport.
pub fn effect_http_client_layer() -> JsEffect {
    let key = effect_service_key(&string("effect/HttpClient"));
    layer_succeed(&key, effect_box(effect_http_client_new()))
}

fn effect_http_request_url(request: &EffectHttpRequestData) -> Option<JsString> {
    let parsed = url_parse(&request.url)?;
    let params = url_search_params(&parsed);
    for (name, value) in &request.url_params {
        search_params_append(&params, name, value);
    }
    Some(url_href(&parsed))
}

/// Execute through the provided native client. The transport starts only when
/// the returned effect is run; promise rejection enters the typed failure
/// channel instead of becoming an unchecked Rust panic.
pub fn effect_http_client_execute(client: &JsEffect, request: &JsEffect) -> JsEffect {
    client.with(|value| match &value.node {
        EffectNode::Data(KernelData::HttpClient) => {}
        _ => effect_unbox_mismatch("HttpClient"),
    });
    let request = effect_http_request_data(request);
    effect_try_promise(
        Rc::new(move || {
            let Some(url) = effect_http_request_url(&request) else {
                let rejected = promise_rejected::<JsEffect>(caught_value(effect_http_client_error("TransportError")));
                return promise_to_handle(&rejected);
            };
            let headers = array_new(
                request.headers.iter().flat_map(|(name, value)| [name.clone(), value.clone()]).collect(),
            );
            let body = request.body_json.as_ref().map(|json| buffer_from_string(json, &string("utf8")));
            let response = fetch_start(&url, &request.method, &headers, body.as_ref());
            promise_to_mapped_handle(&response, effect_http_response_new)
        }),
        Rc::new(|_| effect_box(effect_http_client_error("TransportError"))),
        // The captured request description contains only immutable strings;
        // it has no cycle-collected heap edges.
        Box::new(|_| {}),
    )
}

pub fn effect_http_response_status(response: &JsEffect) -> f64 {
    http_request_status_code(&effect_http_response_data(response)).unwrap_or(200.0)
}

pub fn effect_http_response_header(response: &JsEffect, name: &JsString) -> Option<EffectValue> {
    fetch_response_header(&effect_http_response_data(response), name).map(effect_box)
}

pub fn effect_http_response_stream(response: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::HttpStream(effect_http_response_data(response))))
}

fn effect_http_stream_data(handle: &JsEffect) -> JsHttpRequest {
    handle.with(|value| match &value.node {
        EffectNode::Data(KernelData::HttpStream(response)) => response.clone(),
        _ => effect_unbox_mismatch("Stream<Uint8Array>"),
    })
}

/// Drive a response body with one callback effect at a time. Pausing the
/// request while each callback runs supplies backpressure and keeps the
/// caller's service context available to nested callback effects.
pub fn effect_http_stream_run_for_each(
    stream: &JsEffect,
    callback: Rc<dyn Fn(JsBytes<u8>) -> JsEffect>,
    trace: NetTrace,
) -> JsEffect {
    let response = effect_http_stream_data(stream);
    let keep_response = response.clone();
    let keep_callback = callback.clone();
    let keep_trace = trace.clone();
    effect_with_fiber(
        Rc::new(move |context| {
            let response = response.clone();
            let callback = callback.clone();
            let trace = trace.clone();
            let context = context.clone();
            effect_try_promise(
                Rc::new(move || {
                    let done = promise_new::<()>();
                    if !http_request_claim_fetch_body(&response) {
                        let _ = promise_reject(&done, caught_value(effect_http_client_error("ResponseError")));
                        return promise_to_handle(&done);
                    }
                    let active = Rc::new(Cell::new(true));
                    let data_done = done.clone();
                    let data_active = active.clone();
                    let data_response = response.clone();
                    let data_callback = callback.clone();
                    let data_context = context.clone();
                    http_request_on_data(
                        &response,
                        Rc::new(move |chunk, _| {
                            if !data_active.get() { return; }
                            http_request_pause(&data_response);
                            let next = effect_in_context(&data_callback(chunk), &data_context);
                            let settled = effect_run_promise::<()>(&next, Rc::new(|_| ()));
                            let resume_response = data_response.clone();
                            let settle_done = data_done.clone();
                            let settle_active = data_active.clone();
                            promise_then(&settled, Box::new(move |outcome| match outcome {
                                Ok(()) => http_request_resume(&resume_response),
                                Err(reason) => {
                                    settle_active.set(false);
                                    http_request_destroy(&resume_response);
                                    let _ = promise_reject(&settle_done, reason);
                                }
                            }));
                        }),
                        trace.clone(),
                        false,
                    );
                    let end_done = done.clone();
                    let end_active = active.clone();
                    http_request_on_end(
                        &response,
                        Rc::new(move || {
                            if end_active.replace(false) {
                                let _ = promise_fulfill(&end_done, ());
                            }
                        }),
                        trace.clone(),
                        true,
                    );
                    let abort_done = done.clone();
                    let abort_active = active.clone();
                    http_request_on_aborted(
                        &response,
                        Rc::new(move || {
                            if abort_active.replace(false) {
                                let _ = promise_reject(&abort_done, caught_value(effect_http_client_error("ResponseError")));
                            }
                        }),
                        trace.clone(),
                        true,
                    );
                    http_request_resume(&response);
                    promise_to_handle(&done)
                }),
                Rc::new(|caught| caught.value.clone()),
                Box::new(|_| {}),
            )
        }),
        Box::new(move |tracer| {
            tracer.edge(&keep_response);
            (keep_trace)(tracer);
            let _ = &keep_callback;
        }),
    )
}
