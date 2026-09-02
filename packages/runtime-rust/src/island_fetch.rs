/* The Boa island's fetch transport.
 *
 * JavaScript in island_web.js owns Web-facing coercion and the Response /
 * Headers classes. This module owns the native I/O seam: one request enters
 * the same HTTP client and event loop used by statically compiled node:http,
 * then settles a Boa promise with a transport row. Keeping the row private to
 * the web prelude lets streaming replace the buffered body without changing
 * generated Rust or the frontend's island interface. */

type IslandFetchResolvers = boa_engine::builtins::promise::ResolvingFunctions;

/// `host.urlResolve(base, reference)` — the WHATWG resolution step used by
/// redirect following. Keeping it native reuses the same URL parser as the
/// statically compiled runtime instead of growing a second JS URL parser.
fn island_host_url_resolve(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let base = island_host_arg_string(arguments, 0, context)?;
    let reference = island_host_arg_string(arguments, 1, context)?;
    let base = url::Url::parse(&base).map_err(|_| {
        boa_engine::JsNativeError::typ().with_message("fetch received an invalid base URL")
    })?;
    let resolved = base.join(&reference).map_err(|_| {
        boa_engine::JsNativeError::typ().with_message("fetch received an invalid redirect URL")
    })?;
    Ok(island_host_string(&string(resolved.as_str())))
}

fn island_fetch_string_list(value: JsValue, context: &mut Context) -> JsResult<JsArray<JsString>> {
    let Some(object) = value.as_object() else {
        return Err(boa_engine::JsNativeError::typ()
            .with_message("fetch headers must be a flat array")
            .into());
    };
    let array = BoaJsArray::from_object(object)?;
    let length = array.length(context)?;
    let mut values = Vec::with_capacity(length as usize);
    for index in 0..length {
        let value = array.at(index as i64, context)?.to_string(context)?;
        values.push(Rc::from(value.to_std_string_lossy().as_str()));
    }
    Ok(array_new(values))
}

fn island_fetch_response_row(
    status: f64,
    status_text: &JsString,
    url: &JsString,
    headers: &[(JsString, JsString)],
    body: &[u8],
    context: &mut Context,
) -> JsResult<JsValue> {
    let flat_headers = headers.iter().flat_map(|(name, value)| {
        [island_host_string(name), island_host_string(value)]
    });
    let headers = BoaJsArray::from_iter(flat_headers, context);
    let body = BoaJsUint8Array::from_iter(body.iter().copied(), context)?;
    Ok(BoaJsArray::from_iter(
        [
            JsValue::from(status),
            island_host_string(status_text),
            island_host_string(url),
            headers.into(),
            body.into(),
        ],
        context,
    )
    .into())
}

fn island_fetch_resolve(
    resolvers: IslandFetchResolvers,
    status: f64,
    status_text: JsString,
    url: JsString,
    headers: Vec<(JsString, JsString)>,
    body: Vec<u8>,
) {
    with_island_state(|state| {
        let value = island_fetch_response_row(
            status,
            &status_text,
            &url,
            &headers,
            &body,
            &mut state.context,
        )
        .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        resolvers
            .resolve
            .call(&JsValue::undefined(), &[value], &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        island_run_jobs(state);
    });
}

fn island_fetch_reject(resolvers: IslandFetchResolvers, error: JsError) {
    with_island_state(|state| {
        let error = island_host_error(&caught_value(error), &mut state.context)
            .into_opaque(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        resolvers
            .reject
            .call(&JsValue::undefined(), &[error], &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        island_run_jobs(state);
    });
}

/// `host.fetch(url, method, flatHeaders, bodyBytes)`.
///
/// The promise currently settles once the response body is buffered. The
/// transport and public row deliberately retain status, URL, headers and raw
/// bytes so the next slice can expose streaming without replacing this seam.
fn island_host_fetch(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let url: JsString = Rc::from(island_host_arg_string(arguments, 0, context)?.as_str());
    let method: JsString = Rc::from(island_host_arg_string(arguments, 1, context)?.as_str());
    let headers = island_fetch_string_list(island_host_arg(arguments, 2), context)?;
    let body = island_host_arg_bytes(arguments, 3, context)?;
    let protocol = island_host_run(
        || url_protocol(&url_new(&url)),
        context,
    )?;
    let secure = match protocol.as_ref() {
        "http:" => false,
        "https:" => true,
        _ => {
            return Err(boa_engine::JsNativeError::typ()
                .with_message(format!("fetch does not support protocol {protocol}"))
                .into());
        }
    };

    let (promise, resolvers) = BoaJsPromise::new_pending(context);
    let response_resolvers = resolvers.clone();
    let response_url = url.clone();
    let response_callback = Rc::new(move |response: JsHttpRequest| {
        let status = http_request_status_code(&response).unwrap_or(0.0);
        let status_text = http_request_status_message(&response).unwrap_or_else(empty_string);
        let headers = http_request_headers(&response);
        let body = Rc::new(RefCell::new(Vec::<u8>::new()));
        let body_data = body.clone();
        http_request_on_data(
            &response,
            Rc::new(move |chunk| body_data.borrow_mut().extend(bytes_u8_values(&chunk))),
            Rc::new(|_| {}),
            false,
        );
        let end_resolvers = response_resolvers.clone();
        let end_url = response_url.clone();
        http_request_on_end(
            &response,
            Rc::new(move || {
                island_fetch_resolve(
                    end_resolvers.clone(),
                    status,
                    status_text.clone(),
                    end_url.clone(),
                    headers.clone(),
                    body.borrow().clone(),
                );
            }),
            Rc::new(|_| {}),
            true,
        );
    });
    let request = island_host_run(
        || {
            let (host, port, path) = http_client_url_parts(&url, secure);
            http_client_new(
                &host,
                port,
                &path,
                &method,
                secure,
                0.0,
                &headers,
                false,
                true,
                &empty_string(),
                Some((response_callback, Rc::new(|_| {}))),
            )
        },
        context,
    )?;
    request.with_mut(|request| request.half_close_after_write = false);
    let error_resolvers = resolvers;
    http_client_on_error(
        &request,
        Rc::new(move |error| island_fetch_reject(error_resolvers.clone(), error)),
        Rc::new(|_| {}),
        true,
    );
    if bytes_len(&body) == 0.0 {
        http_client_end(&request);
    } else {
        http_client_end_bytes(&request, &body);
    }
    Ok(promise.into())
}
