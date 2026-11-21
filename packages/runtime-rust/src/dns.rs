use std::net::ToSocketAddrs;

#[derive(Clone, Debug, PartialEq)]
pub struct DnsMxRecord {
    pub priority: f64,
    pub exchange: JsString,
}

impl ArrayElement for DnsMxRecord {}

#[derive(Clone, Debug, PartialEq)]
pub enum DnsValue {
    String(JsString),
    Number(f64),
    Array(Vec<DnsValue>),
    Object(Vec<(JsString, DnsValue)>),
}

impl HeapValue for DnsValue {}

#[derive(Clone, Copy)]
enum DnsRecordKind {
    A = 1,
    Ns = 2,
    Cname = 5,
    Soa = 6,
    Ptr = 12,
    Mx = 15,
    Txt = 16,
    Aaaa = 28,
    Srv = 33,
    Naptr = 35,
    Caa = 257,
}

enum DnsRecords {
    Mx(Vec<DnsMxRecord>),
    Txt(Vec<JsArray<JsString>>),
    Value(DnsValue),
}

fn dns_encode_name(hostname: &str, packet: &mut Vec<u8>) -> Result<(), &'static str> {
    let hostname = hostname.trim_end_matches('.');
    if hostname.is_empty() || hostname.len() > 253 {
        return Err("BADNAME");
    }
    for label in hostname.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err("BADNAME");
        }
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    Ok(())
}

fn dns_read_u16(packet: &[u8], offset: usize) -> Result<u16, &'static str> {
    let bytes = packet.get(offset..offset + 2).ok_or("BADRESP")?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn dns_read_u32(packet: &[u8], offset: usize) -> Result<u32, &'static str> {
    let bytes = packet.get(offset..offset + 4).ok_or("BADRESP")?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn dns_read_character_string(
    packet: &[u8],
    offset: &mut usize,
    end: usize,
) -> Result<JsString, &'static str> {
    let size = usize::from(*packet.get(*offset).ok_or("BADRESP")?);
    *offset += 1;
    let next = (*offset).checked_add(size).ok_or("BADRESP")?;
    let bytes = packet
        .get(*offset..next)
        .filter(|_| next <= end)
        .ok_or("BADRESP")?;
    *offset = next;
    Ok(string(&String::from_utf8_lossy(bytes)))
}

fn dns_read_name(packet: &[u8], start: usize) -> Result<(String, usize), &'static str> {
    let mut labels = Vec::new();
    let mut offset = start;
    let mut consumed = 0usize;
    let mut jumped = false;
    for _ in 0..128 {
        let length = *packet.get(offset).ok_or("BADRESP")?;
        if length & 0xc0 == 0xc0 {
            let tail = *packet.get(offset + 1).ok_or("BADRESP")?;
            let pointer = usize::from(u16::from(length & 0x3f) << 8 | u16::from(tail));
            if pointer >= packet.len() {
                return Err("BADRESP");
            }
            if !jumped {
                consumed += 2;
            }
            offset = pointer;
            jumped = true;
            continue;
        }
        if length & 0xc0 != 0 {
            return Err("BADRESP");
        }
        offset += 1;
        if !jumped {
            consumed += 1;
        }
        if length == 0 {
            return Ok((labels.join("."), consumed));
        }
        let end = offset.checked_add(usize::from(length)).ok_or("BADRESP")?;
        let label = packet.get(offset..end).ok_or("BADRESP")?;
        labels.push(String::from_utf8_lossy(label).into_owned());
        if !jumped {
            consumed += usize::from(length);
        }
        offset = end;
    }
    Err("BADRESP")
}

fn dns_parse_response(
    packet: &[u8],
    transaction: u16,
    kind: DnsRecordKind,
) -> Result<DnsRecords, &'static str> {
    if packet.len() < 12 || dns_read_u16(packet, 0)? != transaction {
        return Err("BADRESP");
    }
    let flags = dns_read_u16(packet, 2)?;
    if flags & 0x8000 == 0 {
        return Err("BADRESP");
    }
    match flags & 0x000f {
        0 => {}
        3 => return Err("ENOTFOUND"),
        2 => return Err("SERVFAIL"),
        _ => return Err("BADRESP"),
    }
    let questions = usize::from(dns_read_u16(packet, 4)?);
    let answers = usize::from(dns_read_u16(packet, 6)?);
    let mut offset = 12usize;
    for _ in 0..questions {
        let (_, used) = dns_read_name(packet, offset)?;
        offset = offset.checked_add(used + 4).ok_or("BADRESP")?;
        if offset > packet.len() {
            return Err("BADRESP");
        }
    }
    let mut mx = Vec::new();
    let mut txt = Vec::new();
    let mut values = Vec::new();
    for _ in 0..answers {
        let (_, used) = dns_read_name(packet, offset)?;
        offset = offset.checked_add(used).ok_or("BADRESP")?;
        let record_type = dns_read_u16(packet, offset)?;
        let class = dns_read_u16(packet, offset + 2)?;
        let ttl = f64::from(dns_read_u32(packet, offset + 4)?);
        let length = usize::from(dns_read_u16(packet, offset + 8)?);
        let data = offset.checked_add(10).ok_or("BADRESP")?;
        let end = data.checked_add(length).ok_or("BADRESP")?;
        if end > packet.len() {
            return Err("BADRESP");
        }
        if class == 1 && record_type == kind as u16 {
            match kind {
                DnsRecordKind::Mx => {
                    if length < 3 {
                        return Err("BADRESP");
                    }
                    let priority = f64::from(dns_read_u16(packet, data)?);
                    let (exchange, _) = dns_read_name(packet, data + 2)?;
                    mx.push(DnsMxRecord {
                        priority,
                        exchange: string(&exchange),
                    });
                }
                DnsRecordKind::Txt => {
                    let mut chunks = Vec::new();
                    let mut cursor = data;
                    while cursor < end {
                        let size = usize::from(packet[cursor]);
                        cursor += 1;
                        let next = cursor.checked_add(size).ok_or("BADRESP")?;
                        let bytes = packet.get(cursor..next).filter(|_| next <= end).ok_or("BADRESP")?;
                        chunks.push(string(&String::from_utf8_lossy(bytes)));
                        cursor = next;
                    }
                    txt.push(array_new(chunks));
                }
                DnsRecordKind::A => {
                    let bytes: [u8; 4] = packet
                        .get(data..end)
                        .and_then(|bytes| bytes.try_into().ok())
                        .ok_or("BADRESP")?;
                    values.push(DnsValue::Object(vec![
                        (
                            string("address"),
                            DnsValue::String(string(&std::net::Ipv4Addr::from(bytes).to_string())),
                        ),
                        (string("ttl"), DnsValue::Number(ttl)),
                    ]));
                }
                DnsRecordKind::Aaaa => {
                    let bytes: [u8; 16] = packet
                        .get(data..end)
                        .and_then(|bytes| bytes.try_into().ok())
                        .ok_or("BADRESP")?;
                    values.push(DnsValue::Object(vec![
                        (
                            string("address"),
                            DnsValue::String(string(&std::net::Ipv6Addr::from(bytes).to_string())),
                        ),
                        (string("ttl"), DnsValue::Number(ttl)),
                    ]));
                }
                DnsRecordKind::Ns | DnsRecordKind::Cname | DnsRecordKind::Ptr => {
                    let (name, _) = dns_read_name(packet, data)?;
                    values.push(DnsValue::String(string(&name)));
                }
                DnsRecordKind::Srv => {
                    if length < 7 {
                        return Err("BADRESP");
                    }
                    let (name, _) = dns_read_name(packet, data + 6)?;
                    values.push(DnsValue::Object(vec![
                        (
                            string("priority"),
                            DnsValue::Number(f64::from(dns_read_u16(packet, data)?)),
                        ),
                        (
                            string("weight"),
                            DnsValue::Number(f64::from(dns_read_u16(packet, data + 2)?)),
                        ),
                        (
                            string("port"),
                            DnsValue::Number(f64::from(dns_read_u16(packet, data + 4)?)),
                        ),
                        (string("name"), DnsValue::String(string(&name))),
                    ]));
                }
                DnsRecordKind::Soa => {
                    let (nsname, first) = dns_read_name(packet, data)?;
                    let (hostmaster, second) = dns_read_name(packet, data + first)?;
                    let numbers = data + first + second;
                    if numbers + 20 > end {
                        return Err("BADRESP");
                    }
                    values.push(DnsValue::Object(vec![
                        (string("nsname"), DnsValue::String(string(&nsname))),
                        (
                            string("hostmaster"),
                            DnsValue::String(string(&hostmaster)),
                        ),
                        (
                            string("serial"),
                            DnsValue::Number(f64::from(dns_read_u32(packet, numbers)?)),
                        ),
                        (
                            string("refresh"),
                            DnsValue::Number(f64::from(dns_read_u32(packet, numbers + 4)?)),
                        ),
                        (
                            string("retry"),
                            DnsValue::Number(f64::from(dns_read_u32(packet, numbers + 8)?)),
                        ),
                        (
                            string("expire"),
                            DnsValue::Number(f64::from(dns_read_u32(packet, numbers + 12)?)),
                        ),
                        (
                            string("minttl"),
                            DnsValue::Number(f64::from(dns_read_u32(packet, numbers + 16)?)),
                        ),
                    ]));
                }
                DnsRecordKind::Naptr => {
                    if length < 7 {
                        return Err("BADRESP");
                    }
                    let mut cursor = data + 4;
                    let flags = dns_read_character_string(packet, &mut cursor, end)?;
                    let service = dns_read_character_string(packet, &mut cursor, end)?;
                    let regexp = dns_read_character_string(packet, &mut cursor, end)?;
                    let (replacement, _) = dns_read_name(packet, cursor)?;
                    values.push(DnsValue::Object(vec![
                        (string("flags"), DnsValue::String(flags)),
                        (string("service"), DnsValue::String(service)),
                        (string("regexp"), DnsValue::String(regexp)),
                        (
                            string("replacement"),
                            DnsValue::String(string(&replacement)),
                        ),
                        (
                            string("order"),
                            DnsValue::Number(f64::from(dns_read_u16(packet, data)?)),
                        ),
                        (
                            string("preference"),
                            DnsValue::Number(f64::from(dns_read_u16(packet, data + 2)?)),
                        ),
                    ]));
                }
                DnsRecordKind::Caa => {
                    if length < 2 {
                        return Err("BADRESP");
                    }
                    let tag_length = usize::from(packet[data + 1]);
                    let tag_end = data + 2 + tag_length;
                    let tag = packet.get(data + 2..tag_end).ok_or("BADRESP")?;
                    let value = packet.get(tag_end..end).ok_or("BADRESP")?;
                    values.push(DnsValue::Object(vec![
                        (
                            string("critical"),
                            DnsValue::Number(f64::from(packet[data])),
                        ),
                        (
                            string(&String::from_utf8_lossy(tag)),
                            DnsValue::String(string(&String::from_utf8_lossy(value))),
                        ),
                    ]));
                }
            }
        }
        offset = end;
    }
    match kind {
        DnsRecordKind::Mx if !mx.is_empty() => Ok(DnsRecords::Mx(mx)),
        DnsRecordKind::Txt if !txt.is_empty() => Ok(DnsRecords::Txt(txt)),
        DnsRecordKind::Soa if values.len() == 1 => Ok(DnsRecords::Value(values.remove(0))),
        _ if !values.is_empty() => Ok(DnsRecords::Value(DnsValue::Array(values))),
        _ => Err("ENODATA"),
    }
}

fn dns_resolver_addresses() -> Vec<std::net::SocketAddr> {
    let mut servers = Vec::new();
    if let Ok(config) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in config.lines() {
            let mut parts = line.split_whitespace();
            if parts.next() == Some("nameserver")
                && let Some(address) = parts.next()
                && let Ok(ip) = address.parse::<std::net::IpAddr>()
            {
                servers.push(std::net::SocketAddr::new(ip, 53));
            }
        }
    }
    for address in ["1.1.1.1:53", "8.8.8.8:53"] {
        if let Ok(address) = address.parse() {
            servers.push(address);
        }
    }
    servers
}

fn dns_query(hostname: &str, kind: DnsRecordKind) -> Result<DnsRecords, &'static str> {
    use std::sync::atomic::{AtomicU16, Ordering};
    static NEXT_ID: AtomicU16 = AtomicU16::new(0x5343);
    let transaction = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut query = Vec::with_capacity(512);
    query.extend_from_slice(&transaction.to_be_bytes());
    query.extend_from_slice(&0x0100u16.to_be_bytes());
    query.extend_from_slice(&1u16.to_be_bytes());
    query.extend_from_slice(&[0; 6]);
    dns_encode_name(hostname, &mut query)?;
    query.extend_from_slice(&(kind as u16).to_be_bytes());
    query.extend_from_slice(&1u16.to_be_bytes());
    let mut last = "ETIMEOUT";
    for resolver in dns_resolver_addresses() {
        let bind = if resolver.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
        let Ok(socket) = std::net::UdpSocket::bind(bind) else {
            last = "SERVFAIL";
            continue;
        };
        let timeout = Some(std::time::Duration::from_secs(2));
        let _ = socket.set_read_timeout(timeout);
        let _ = socket.set_write_timeout(timeout);
        if socket.connect(resolver).is_err() || socket.send(&query).is_err() {
            last = "SERVFAIL";
            continue;
        }
        let mut response = [0u8; 4096];
        match socket.recv(&mut response) {
            Ok(size) => match dns_parse_response(&response[..size], transaction, kind) {
                Ok(records) => return Ok(records),
                Err(code) => last = code,
            },
            Err(_) => last = "ETIMEOUT",
        }
    }
    Err(last)
}

fn dns_reject<T: HeapValue>(promise: &JsPromise<T>, hostname: &JsString, operation: &str, code: &str) {
    let error = error_new_code(
        "Error",
        string(&format!("{operation} {code} {hostname}")),
        code,
    );
    let _ = promise_reject(promise, caught_value(error));
}

pub fn dns_resolve_mx_promise(hostname: &JsString) -> JsPromise<JsArray<DnsMxRecord>> {
    let result = promise_new();
    let target = result.clone();
    let hostname = hostname.clone();
    process_next_tick(Box::new(move || match dns_query(hostname.to_utf8_lossy(), DnsRecordKind::Mx) {
        Ok(DnsRecords::Mx(records)) => {
            let _ = promise_fulfill(&target, array_new(records));
        }
        Ok(DnsRecords::Txt(_)) => unreachable!(),
        Ok(DnsRecords::Value(_)) => unreachable!(),
        Err(code) => dns_reject(&target, &hostname, "queryMx", code),
    }));
    result
}

pub fn dns_resolve_txt_promise(hostname: &JsString) -> JsPromise<JsArray<JsArray<JsString>>> {
    let result = promise_new();
    let target = result.clone();
    let hostname = hostname.clone();
    process_next_tick(Box::new(move || match dns_query(hostname.to_utf8_lossy(), DnsRecordKind::Txt) {
        Ok(DnsRecords::Txt(records)) => {
            let _ = promise_fulfill(&target, array_new(records));
        }
        Ok(DnsRecords::Mx(_)) => unreachable!(),
        Ok(DnsRecords::Value(_)) => unreachable!(),
        Err(code) => dns_reject(&target, &hostname, "queryTxt", code),
    }));
    result
}

fn dns_reverse_name(hostname: &str) -> Result<String, &'static str> {
    match hostname.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(address)) => {
            let octets = address.octets();
            Ok(format!(
                "{}.{}.{}.{}.in-addr.arpa",
                octets[3], octets[2], octets[1], octets[0]
            ))
        }
        Ok(std::net::IpAddr::V6(address)) => {
            let mut output = String::new();
            for byte in address.octets().into_iter().rev() {
                use std::fmt::Write;
                let _ = write!(output, "{:x}.{:x}.", byte & 0x0f, byte >> 4);
            }
            output.push_str("ip6.arpa");
            Ok(output)
        }
        Err(_) => Err("BADNAME"),
    }
}

pub fn dns_resolve_record_promise(
    hostname: &JsString,
    record_type: u16,
    ttl: bool,
    reverse: bool,
) -> JsPromise<DnsValue> {
    let result = promise_new();
    let target = result.clone();
    let hostname = hostname.clone();
    process_next_tick(Box::new(move || {
        let kind = match record_type {
            1 => DnsRecordKind::A,
            2 => DnsRecordKind::Ns,
            5 => DnsRecordKind::Cname,
            6 => DnsRecordKind::Soa,
            12 => DnsRecordKind::Ptr,
            28 => DnsRecordKind::Aaaa,
            33 => DnsRecordKind::Srv,
            35 => DnsRecordKind::Naptr,
            257 => DnsRecordKind::Caa,
            _ => unreachable!("validated DNS record type"),
        };
        let query_name = if reverse {
            match dns_reverse_name(hostname.to_utf8_lossy()) {
                Ok(name) => name,
                Err(code) => {
                    dns_reject(&target, &hostname, "getHostByAddr", code);
                    return;
                }
            }
        } else {
            hostname.to_utf8_lossy().to_owned()
        };
        match dns_query(&query_name, kind) {
            Ok(DnsRecords::Value(mut value)) => {
                if matches!(kind, DnsRecordKind::A | DnsRecordKind::Aaaa)
                    && !ttl
                    && let DnsValue::Array(records) = value
                {
                    value = DnsValue::Array(
                        records
                            .into_iter()
                            .map(|record| match record {
                                DnsValue::Object(fields) => fields
                                    .into_iter()
                                    .find_map(|(key, value)| (key == "address").then_some(value))
                                    .unwrap_or_else(|| DnsValue::String(empty_string())),
                                value => value,
                            })
                            .collect(),
                    );
                }
                let _ = promise_fulfill(&target, value);
            }
            Ok(DnsRecords::Mx(_) | DnsRecords::Txt(_)) => unreachable!(),
            Err(code) => dns_reject(&target, &hostname, "query", code),
        }
    }));
    result
}

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

pub type DnsLookupAllCallback = Rc<dyn Fn(Result<Vec<(JsString, f64)>, JsError>)>;

/// Resolve every address accepted by Node's callback-style `dns.lookup`.
/// Results are deduplicated because some platform resolvers repeat records.
pub fn dns_lookup_all(
    hostname: &JsString,
    family: f64,
    ipv4_first: bool,
    callback: DnsLookupAllCallback,
) {
    let host = hostname.to_utf8_lossy();
    let result = if family != 0.0 && family != 4.0 && family != 6.0 {
        Err(error_new_code(
            "TypeError",
            string(&format!(
                "The property 'options.family' must be one of: 0, 4, 6. Received {}",
                number_to_string(family)
            )),
            "ERR_INVALID_ARG_VALUE",
        ))
    } else {
        let mut seen = std::collections::HashSet::new();
        let mut addresses = (host, 0)
            .to_socket_addrs()
            .ok()
            .into_iter()
            .flatten()
            .filter(|address| {
                family == 0.0
                    || (family == 4.0 && address.is_ipv4())
                    || (family == 6.0 && address.is_ipv6())
            })
            .filter_map(|address| {
                let address = address.ip();
                seen.insert(address).then(|| {
                    (
                        string(&address.to_string()),
                        if address.is_ipv4() { 4.0 } else { 6.0 },
                    )
                })
            })
            .collect::<Vec<_>>();
        if ipv4_first {
            addresses.sort_by_key(|(_, family)| if *family == 4.0 { 0 } else { 1 });
        }
        if addresses.is_empty() {
            Err(error_new_code(
                "Error",
                string(&format!("getaddrinfo ENOTFOUND {hostname}")),
                "ENOTFOUND",
            ))
        } else {
            Ok(addresses)
        }
    };
    process_next_tick(Box::new(move || callback(result)));
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
