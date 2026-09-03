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
        (hostname.as_ref(), 0)
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
