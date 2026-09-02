/* The island's node:http bridge — the SERVER leg and the CLIENT leg over
 * the compiled runtime's own http units.
 *
 * island_host_net.rs owns the socket and the reentry seam
 * (`island_net_call`, the id registry, `island_net_next_id`); this file
 * owns what the shared bootstrap's `30-net-http-tls.js` asks of a host:
 * `srvCreate`/`srvListen`/`srvRes*` for the server, `httpStart`/
 * `httpWrite`/`httpEnd` for the client. Both legs delegate to the SAME
 * `http_*` primitives the static lane lowers to, so a response served
 * from inside the island and one served by compiled code are the same
 * serializer, and an island request and a compiled request are the same
 * bytes on the wire.
 *
 * The CLIENT leg is not here yet: this file lands the server first, so
 * `host.httpStart` is absent and the shim's `http.request` fences.
 *
 * The two legs are registered INDEPENDENTLY on the host object, and the
 * shim gates on each separately: a host that bridges one and not the
 * other fences the missing half loudly instead of half-working.
 */

/// Drop both http registries before the realm goes down (called from
/// `island_net_reset`, which runs ahead of the heap audit).
fn island_http_reset() {
    island_http_exchanges_reset();
}
/* ── the node:http SERVER leg ──────────────────────────────────────────
 *
 * The island owns no listening socket. `http.createServer` in the shared
 * bootstrap mints one HERE — `http_server_new`, the very server the
 * static lane serves from — and every accepted request re-enters the
 * realm as an EXCHANGE ID: the request line and headers arrive as
 * arguments, the response's header block and body chunks leave through
 * the same id. So `app.listen()` inside the island is a real socket on a
 * real port, and the bytes on the wire are the static lane's
 * oracle-pinned bytes rather than a second serializer's guess.
 *
 * `onRequest` RETURNS the per-exchange callbacks object (the C island's
 * shape): the request exists before the shim could have wired anything to
 * it, so the return value IS the wiring.
 */

/// One in-flight request/response pair, addressed by exchange id.
struct IslandHttpExchange {
    request: JsHttpRequest,
    response: JsHttpResponse,
}

thread_local! {
    static ISLAND_HTTP_EXCHANGES: RefCell<HashMap<u64, IslandHttpExchange>> =
        RefCell::new(HashMap::new());
}

fn island_http_exchange(id: u64) -> Option<(JsHttpRequest, JsHttpResponse)> {
    ISLAND_HTTP_EXCHANGES.with(|exchanges| {
        exchanges
            .borrow()
            .get(&id)
            .map(|entry| (entry.request.clone(), entry.response.clone()))
    })
}

fn island_http_exchanges_reset() {
    ISLAND_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow_mut().clear());
}

/// `rawHeaders` — name/value alternating, ORIGINAL case, repeats kept.
/// `http_request_headers` folds repeats and lowercases; the shim needs
/// the unfolded list because Node's `IncomingMessage` builds both from it.
fn island_http_raw_headers(request: &JsHttpRequest, context: &mut Context) -> JsValue {
    let pairs = request.with(|request| {
        request
            .headers
            .iter()
            .map(|(name, _lower, value)| (name.clone(), value.clone()))
            .collect::<Vec<_>>()
    });
    let flat = pairs
        .iter()
        .flat_map(|(name, value)| [island_host_string(name), island_host_string(value)]);
    BoaJsArray::from_iter(flat, context).into()
}

/// `host.srvCreate(callbacks)` → a server id, sharing the net registry so
/// `srvListen`/`srvAddress`/`srvClose` are the SAME host functions the raw
/// `net.Server` uses. Only what an accepted connection becomes differs:
/// an http server dispatches parsed requests, not sockets.
fn island_host_srv_create(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let callbacks = island_net_arg_callbacks(arguments, 0)?;
    let server = http_server_new();
    let id = island_net_next_id();

    let request_callbacks = callbacks.clone();
    http_server_on_request(
        &server,
        Rc::new(move |request: JsHttpRequest, response: JsHttpResponse| {
            island_http_exchange_begin(&request_callbacks, request, response);
        }),
        Rc::new(|_| {}),
        false,
    );

    let listening_callbacks = callbacks.clone();
    net_server_on_listening(
        &server,
        Rc::new(move || {
            island_net_call(&listening_callbacks, "onListening", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        false,
    );

    let close_callbacks = callbacks.clone();
    net_server_on_close(
        &server,
        Rc::new(move || {
            island_net_call(&close_callbacks, "onClose", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        false,
    );

    ISLAND_NET_SERVERS.with(|servers| servers.borrow_mut().insert(id, server));
    ISLAND_NET_SERVER_CALLBACKS.with(|slot| slot.borrow_mut().insert(id, callbacks));
    Ok(JsValue::from(id as f64))
}

/// Hand one accepted request to the realm and wire what comes back.
fn island_http_exchange_begin(
    callbacks: &boa_engine::JsObject,
    request: JsHttpRequest,
    response: JsHttpResponse,
) {
    let id = island_net_next_id();
    ISLAND_HTTP_EXCHANGES.with(|exchanges| {
        exchanges.borrow_mut().insert(
            id,
            IslandHttpExchange {
                request: request.clone(),
                response: response.clone(),
            },
        );
    });
    let method = http_request_method(&request);
    let url = http_request_url(&request);
    let peer = request.with(|request| {
        request.socket.as_ref().and_then(|socket| {
            socket.with(|socket| {
                socket
                    .stream
                    .as_ref()
                    .and_then(|stream| stream.peer_addr().ok())
            })
        })
    });
    let header_request = request.clone();
    let answer = island_net_call(callbacks, "onRequest", |context| {
        let peer = peer.map_or_else(JsValue::undefined, |peer| {
            JsValue::from(boa_engine::JsString::from(peer.ip().to_string().as_str()))
        });
        vec![
            JsValue::from(id as f64),
            island_host_string(&method),
            island_host_string(&url),
            island_http_raw_headers(&header_request, context),
            // The server parser accepts HTTP/1.1 only, so the version the
            // shim reports is the one that was spoken.
            JsValue::from(1.0),
            JsValue::from(1.0),
            peer,
        ]
    });
    let Some(wiring) = answer.as_object() else {
        // The shim declined (or threw): close the exchange rather than
        // leaving a request whose body nothing will ever read.
        ISLAND_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow_mut().remove(&id));
        return;
    };

    let close_wiring = wiring.clone();
    http_response_on_close(
        &response,
        Rc::new(move || {
            ISLAND_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow_mut().remove(&id));
            island_net_call(&close_wiring, "onClose", |_| Vec::new());
        }),
        Rc::new(|_| {}),
    );

    let end_wiring = wiring.clone();
    http_request_on_end(
        &request,
        Rc::new(move || {
            island_net_call(&end_wiring, "onEnd", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        true,
    );

    // Filing the data listener FLUSHES whatever the parser already read,
    // so this goes last: `onEnd` must be reachable before the body that
    // completes it can arrive.
    let data_wiring = wiring;
    http_request_on_data(
        &request,
        Rc::new(move |chunk| {
            island_net_call(&data_wiring, "onData", |context| {
                let bytes = BoaJsUint8Array::from_iter(bytes_u8_values(&chunk), context)
                    .map(JsValue::from)
                    .unwrap_or_else(|error| island_eval_error(error, context));
                vec![bytes]
            });
        }),
        Rc::new(|_| {}),
        false,
    );
}

fn island_host_srv_port(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let Some(server) = island_net_server(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::from(0.0));
    };
    Ok(JsValue::from(net_server_port(&server)))
}

/// `host.srvResHead(id, status, statusMessage, flatHeaders)`.
///
/// The shim owns the header STORE (Node's writeHead rules, the
/// writeHead-only headers that never become readable), so the flat list
/// that arrives is the complete set: it REPLACES the response's headers
/// rather than merging, which is also what keeps repeats — `set-cookie`,
/// above all — from collapsing through a set-header call.
fn island_host_srv_res_head(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some((_, response)) = island_http_exchange(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::undefined());
    };
    let status = island_host_arg_number(arguments, 1, context)?;
    if !island_host_arg(arguments, 2).is_null_or_undefined() {
        let message: JsString = Rc::from(island_host_arg_string(arguments, 2, context)?.as_str());
        http_response_status_message_set(&response, &message);
    }
    let flat = island_fetch_string_list(island_host_arg(arguments, 3), context)?;
    let length = array_len(&flat) as usize;
    let mut headers = Vec::with_capacity(length / 2);
    for index in (0..length.saturating_sub(1)).step_by(2) {
        headers.push((
            array_get(&flat, index as f64),
            array_get(&flat, (index + 1) as f64),
        ));
    }
    response.with_mut(|response| {
        if !response.headers_sent {
            response.headers = headers;
        }
    });
    island_host_run(|| http_response_write_head(&response, status), context)?;
    Ok(JsValue::undefined())
}

fn island_host_srv_res_write(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some((_, response)) = island_http_exchange(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::from(false));
    };
    let bytes = island_host_arg_bytes(arguments, 1, context)?;
    island_host_run(|| http_response_write_bytes(&response, &bytes), context)?;
    Ok(JsValue::from(true))
}

fn island_host_srv_res_end(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some((_, response)) = island_http_exchange(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::undefined());
    };
    if island_host_arg(arguments, 1).is_null_or_undefined() {
        island_host_run(|| http_response_end(&response), context)?;
    } else {
        let bytes = island_host_arg_bytes(arguments, 1, context)?;
        island_host_run(|| http_response_end_bytes(&response, &bytes), context)?;
    }
    Ok(JsValue::undefined())
}

/// `host.srvResDestroy(id)` — `req.destroy()` on a served request, which
/// in Node tears the CONNECTION down rather than completing the response.
fn island_host_srv_res_destroy(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let id = island_net_arg_id(arguments, 0);
    let Some((request, _)) = island_http_exchange(id) else {
        return Ok(JsValue::undefined());
    };
    ISLAND_HTTP_EXCHANGES.with(|exchanges| exchanges.borrow_mut().remove(&id));
    let socket = request.with(|request| request.socket.clone());
    if let Some(socket) = socket {
        net_socket_destroy(&socket);
    }
    Ok(JsValue::undefined())
}

