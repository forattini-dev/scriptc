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
 * The two legs are registered INDEPENDENTLY on the host object, and the
 * shim gates on each separately: a host that bridges one and not the
 * other fences the missing half loudly instead of half-working.
 *
 * THE TLS FENCE (what the next leg owes). `httpStart` refuses `secure`,
 * so node:https loads with Node's shape and throws at the call rather
 * than pretending. Closing it needs three things this file does not
 * have: a client that dials through `tls_client.rs` instead of
 * `net_socket_connect` (the static lane reaches it through
 * `https_client_request`, whose transport `http_client_new` deliberately
 * leaves unbuilt for `secure`); a `srvCreate` variant that installs a
 * `tls_config` on the server, which needs cert/key material plumbed in
 * from the shim — a separate seam the C island fences too; and the
 * `rejectUnauthorized`/`ca` options carried down from the shim's request
 * options, which today are hard-wired to the runtime's defaults.
 */

/// Drop both http registries before the realm goes down (called from
/// `island_net_reset`, which runs ahead of the heap audit).
fn island_http_reset() {
    island_http_exchanges_reset();
    island_http_clients_reset();
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
        Rc::new(move |chunk, _encoding_utf8| {
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
/* ── the node:http CLIENT leg ──────────────────────────────────────────
 *
 * `http.request`/`http.get` in the shared bootstrap run ONE
 * `http_client_*` exchange per request — the same client the static lane
 * lowers to, so an island request and a compiled one put the same bytes
 * on the wire. The shim owns node:http's semantics (no redirects, no
 * decompression, no default accept-* headers); this bridge owns the
 * transport and the event relay.
 *
 * Lifetime: the registry holds the exchange while it is live, and it is
 * dropped on the FIRST of close, error or teardown. The `settled` flag is
 * shared with the timeout timer so a late fire cannot resurrect a
 * finished exchange.
 */

/// One in-flight client exchange.
struct IslandHttpClientEntry {
    request: JsHttpClientRequest,
    /// Set once a close, an error or teardown has retired the exchange —
    /// shared with the timeout timer so a late fire cannot resurrect it.
    settled: Rc<Cell<bool>>,
    /// Kept so `httpSetTimeout` after the start can re-arm.
    callbacks: boa_engine::JsObject,
}

thread_local! {
    static ISLAND_HTTP_CLIENTS: RefCell<HashMap<u64, IslandHttpClientEntry>> =
        RefCell::new(HashMap::new());
}

fn island_http_client(id: u64) -> Option<JsHttpClientRequest> {
    ISLAND_HTTP_CLIENTS.with(|clients| {
        clients.borrow().get(&id).map(|entry| entry.request.clone())
    })
}

fn island_http_client_settle(id: u64) {
    if let Some(entry) = ISLAND_HTTP_CLIENTS.with(|clients| clients.borrow_mut().remove(&id)) {
        entry.settled.set(true);
    }
}

fn island_http_clients_reset() {
    let clients = ISLAND_HTTP_CLIENTS.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    for entry in clients.into_values() {
        entry.settled.set(true);
        http_client_destroy(&entry.request);
    }
}

/// Arm the shim's `request.setTimeout`.
///
/// Node's is an IDLE socket timeout; this fires once if the exchange has
/// not settled by then, which is the same observable for the shape the
/// shim exposes (`'timeout'` is emitted, the request is NOT destroyed —
/// Node leaves that decision to the handler). The divergence is the idle
/// reset, and it is recorded in the lane report rather than papered over.
fn island_http_client_arm_timeout(
    callbacks: &boa_engine::JsObject,
    settled: &Rc<Cell<bool>>,
    timeout: f64,
) {
    if !timeout.is_finite() || timeout <= 0.0 {
        return;
    }
    let callbacks = callbacks.clone();
    let settled = settled.clone();
    let mut armed = true;
    let fire: Box<dyn FnMut()> = Box::new(move || {
        if !armed || settled.get() {
            return;
        }
        armed = false;
        island_net_call(&callbacks, "onTimeout", |_| Vec::new());
    });
    timer_set_timeout_handle(fire, timeout);
}

/// `host.httpStart(secure, host, port, path, method, timeoutMs, headers,
/// callbacks)` → an exchange id.
fn island_host_http_start(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let secure = island_host_arg(arguments, 0).to_boolean();
    if secure {
        return Err(boa_engine::JsNativeError::error()
            .with_message(
                "node:https requests are not supported in the scriptc Rust island yet (node:http is)",
            )
            .into());
    }
    let hostname: JsString = Rc::from(island_host_arg_string(arguments, 1, context)?.as_str());
    let port = island_host_arg_number(arguments, 2, context)?;
    let path: JsString = Rc::from(island_host_arg_string(arguments, 3, context)?.as_str());
    let method: JsString = Rc::from(island_host_arg_string(arguments, 4, context)?.as_str());
    let timeout = island_host_arg_number(arguments, 5, context)?;
    let headers = island_fetch_string_list(island_host_arg(arguments, 6), context)?;
    let callbacks = island_net_arg_callbacks(arguments, 7)?;
    let id = island_net_next_id();
    let settled = Rc::new(Cell::new(false));

    let response_callbacks = callbacks.clone();
    let response_callback = Rc::new(move |response: JsHttpRequest| {
        let status = http_request_status_code(&response).unwrap_or(0.0);
        let status_text = http_request_status_message(&response).unwrap_or_else(empty_string);
        let head_response = response.clone();
        island_net_call(&response_callbacks, "onResponse", |context| {
            vec![
                JsValue::from(status),
                island_host_string(&status_text),
                island_http_raw_headers(&head_response, context),
            ]
        });
        let end_callbacks = response_callbacks.clone();
        http_request_on_end(
            &response,
            Rc::new(move || {
                island_net_call(&end_callbacks, "onEnd", |_| Vec::new());
            }),
            Rc::new(|_| {}),
            true,
        );
        // Last, so `onEnd` is reachable before the buffered body that
        // completes it is flushed (the server leg's rule, same reason).
        let data_callbacks = response_callbacks.clone();
        http_request_on_data(
            &response,
            Rc::new(move |chunk, _encoding_utf8| {
                island_net_call(&data_callbacks, "onData", |context| {
                    let bytes = BoaJsUint8Array::from_iter(bytes_u8_values(&chunk), context)
                        .map(JsValue::from)
                        .unwrap_or_else(|error| island_eval_error(error, context));
                    vec![bytes]
                });
            }),
            Rc::new(|_| {}),
            false,
        );
    });

    let request = island_host_run(
        || {
            http_client_new(
                &hostname,
                port,
                &path,
                &method,
                false,
                timeout,
                &headers,
                false,
                true,
                &empty_string(),
                Some((response_callback, Rc::new(|_| {}))),
            )
        },
        context,
    )?;

    let error_callbacks = callbacks.clone();
    http_client_on_error(
        &request,
        Rc::new(move |error| {
            let text = island_net_error_text(&error);
            island_net_call(&error_callbacks, "onError", |_| {
                vec![JsValue::from(boa_engine::JsString::from(text.as_str()))]
            });
        }),
        Rc::new(|_| {}),
        true,
    );

    let close_callbacks = callbacks.clone();
    http_client_on_close(
        &request,
        Rc::new(move || {
            island_http_client_settle(id);
            island_net_call(&close_callbacks, "onClose", |_| Vec::new());
        }),
        Rc::new(|_| {}),
        true,
    );

    island_http_client_arm_timeout(&callbacks, &settled, timeout);
    ISLAND_HTTP_CLIENTS.with(move |clients| {
        clients.borrow_mut().insert(
            id,
            IslandHttpClientEntry {
                request,
                settled,
                callbacks,
            },
        );
    });
    Ok(JsValue::from(id as f64))
}

fn island_host_http_write(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(request) = island_http_client(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::from(false));
    };
    let bytes = island_host_arg_bytes(arguments, 1, context)?;
    island_host_run(|| http_client_write_bytes(&request, &bytes), context)?;
    Ok(JsValue::from(true))
}

fn island_host_http_end(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(request) = island_http_client(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::undefined());
    };
    if island_host_arg(arguments, 1).is_null_or_undefined() {
        island_host_run(|| http_client_end(&request), context)?;
    } else {
        let bytes = island_host_arg_bytes(arguments, 1, context)?;
        island_host_run(|| http_client_end_bytes(&request, &bytes), context)?;
    }
    Ok(JsValue::undefined())
}

fn island_host_http_destroy(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    if let Some(request) = island_http_client(island_net_arg_id(arguments, 0)) {
        http_client_destroy(&request);
    }
    Ok(JsValue::undefined())
}

/// `host.httpSetTimeout(id, ms)` — a re-arm, so `setTimeout` after the
/// exchange started behaves like `setTimeout` before it.
fn island_host_http_set_timeout(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let id = island_net_arg_id(arguments, 0);
    let timeout = island_host_arg_number(arguments, 1, context)?;
    let entry = ISLAND_HTTP_CLIENTS.with(|clients| {
        clients.borrow().get(&id).map(|entry| {
            (
                entry.request.clone(),
                entry.settled.clone(),
                entry.callbacks.clone(),
            )
        })
    });
    let Some((request, settled, callbacks)) = entry else {
        return Ok(JsValue::undefined());
    };
    request.with_mut(|request| request.timeout = timeout);
    island_http_client_arm_timeout(&callbacks, &settled, timeout);
    Ok(JsValue::undefined())
}
