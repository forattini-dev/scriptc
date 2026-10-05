use std::net::ToSocketAddrs;

/// Resolve one IPv4 address synchronously, then deliver the Node-style
/// callback on the next event-loop turn. The frontend admits only family 4.
pub fn dns_lookup(
    hostname: &JsString,
    family: f64,
    callback: Rc<dyn Fn(Option<JsError>, JsString, f64)>,
) {
    let result = if family != 4.0 {
        Err(error_new(
            "Error",
            string(&format!("getaddrinfo EAI_ADDRFAMILY {hostname}")),
        ))
    } else {
        (hostname.to_utf8_lossy(), 0)
            .to_socket_addrs()
            .ok()
            .and_then(|mut addresses| addresses.find(|address| address.is_ipv4()))
            .map(|address| string(&address.ip().to_string()))
            .ok_or_else(|| {
                error_new(
                    "Error",
                    string(&format!("getaddrinfo ENOTFOUND {hostname}")),
                )
            })
    };
    process_next_tick(Box::new(move || match result {
        Ok(address) => callback(None, address, 4.0),
        Err(error) => callback(Some(error), empty_string(), 4.0),
    }));
}

/// Single-result promise lookup. IP literals settle immediately; OS name
/// resolution remains synchronous like the existing callback slice, with
/// fulfillment deferred to the next turn. The mapper captures no JS roots.
pub fn dns_lookup_promise<T: HeapValue>(
    hostname: &JsString,
    family: impl FnOnce() -> f64,
    family_name: &JsString,
    map: impl FnOnce(Option<JsString>, f64) -> T + 'static,
) -> JsPromise<T> {
    let result = promise_new();
    dns_lookup_validate_hostname(hostname);
    dns_lookup_native(hostname, family(), family_name, map, &result, false);
    result
}

/// util.promisify invokes the callback function inside its promise executor:
/// validation throws become rejections, and literals retain next-tick delivery.
pub fn dns_lookup_promisified<T: HeapValue>(
    hostname: &JsString,
    family: impl FnOnce() -> f64,
    family_name: &JsString,
    map: impl FnOnce(Option<JsString>, f64) -> T + 'static,
) -> JsPromise<T> {
    let result = promise_new();
    promise_run_segment(&result, || {
        dns_lookup_validate_hostname(hostname);
        dns_lookup_native(hostname, family(), family_name, map, &result, true);
    });
    result
}

fn dns_lookup_validate_hostname(hostname: &JsString) {
    let host = hostname.to_utf8_lossy();
    if target_runtime_id() == "node26" && host.contains('\0') {
        throw_type_error_code(
            format!(
                "The argument 'hostname' must be a string without null bytes. Received {}",
                inspect_quote(hostname)
            ),
            "ERR_INVALID_ARG_VALUE",
        );
    }
}

fn dns_lookup_native<T: HeapValue>(
    hostname: &JsString,
    family: f64,
    family_name: &JsString,
    map: impl FnOnce(Option<JsString>, f64) -> T + 'static,
    result: &JsPromise<T>,
    defer_literal: bool,
) {
    let host = hostname.to_utf8_lossy();
    if family != 0.0 && family != 4.0 && family != 6.0 {
        let prefix = if family_name == &string("family") {
            "argument"
        } else {
            "property"
        };
        throw_type_error_code(
            format!(
                "The {prefix} '{family_name}' must be one of: 0, 4, 6. Received {}",
                number_to_string(family)
            ),
            "ERR_INVALID_ARG_VALUE",
        );
    }
    if host.is_empty() {
        if target_runtime_id() == "node26" {
            let _ = promise_reject(result, caught_value(error_new_code(
                "TypeError",
                string("The argument 'hostname' must be a non-empty string. Received ''"),
                "ERR_INVALID_ARG_VALUE",
            )));
        } else {
            dns_lookup_deliver(result, None, if family == 6.0 { 6.0 } else { 4.0 }, map, defer_literal);
        }
        return;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        // Node preserves the input spelling and answers its actual family,
        // even when the requested family differs from this IP literal.
        dns_lookup_deliver(result,
            Some(hostname.clone()),
            if ip.is_ipv4() { 4.0 } else { 6.0 },
            map, defer_literal);
        return;
    }
    // Node 24 passes strings to the C resolver without a null-byte check.
    let os_host = host.split('\0').next().unwrap_or(host);
    let address = (os_host, 0)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| {
            addresses.find(|address| {
                family == 0.0
                    || (family == 4.0 && address.is_ipv4())
                    || (family == 6.0 && address.is_ipv6())
            })
        });
    let target = result.clone();
    let hostname = hostname.clone();
    process_next_tick(Box::new(move || {
        if let Some(address) = address {
            let value = map(
                Some(string(&address.ip().to_string())),
                if address.is_ipv4() { 4.0 } else { 6.0 },
            );
            let _ = promise_fulfill(&target, value);
        } else {
            let error = error_new_code(
                "Error",
                string(&format!("getaddrinfo ENOTFOUND {hostname}")),
                "ENOTFOUND",
            );
            let _ = promise_reject(&target, caught_value(error));
        }
    }));
}

fn dns_lookup_deliver<T: HeapValue>(
    result: &JsPromise<T>,
    address: Option<JsString>,
    family: f64,
    map: impl FnOnce(Option<JsString>, f64) -> T + 'static,
    deferred: bool,
) {
    if deferred {
        let target = result.clone();
        process_next_tick(Box::new(move || {
            let _ = promise_fulfill(&target, map(address, family));
        }));
    } else {
        let _ = promise_fulfill(result, map(address, family));
    }
}
