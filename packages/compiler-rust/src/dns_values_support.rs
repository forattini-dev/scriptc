// DNS record payloads enter through NativeValue so the generated program can
// check them against its own record and recursive-array layouts at the await
// boundary. No JavaScript engine or source fallback participates.
fn native_dns_object(entries: Vec<(runtime::JsString, NativeValue)>) -> NativeValue {
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries,
        hash_index: NativeHashIndex::default(),
    }))
}

fn native_dns_value(value: runtime::DnsValue) -> NativeValue {
    match value {
        runtime::DnsValue::String(value) => NativeValue::String(value),
        runtime::DnsValue::Number(value) => NativeValue::Number(value),
        runtime::DnsValue::Array(values) => NativeValue::Array(runtime::array_new(
            values.into_iter().map(native_dns_value).collect(),
        )),
        runtime::DnsValue::Object(entries) => native_dns_object(
            entries
                .into_iter()
                .map(|(key, value)| (key, native_dns_value(value)))
                .collect(),
        ),
    }
}

fn native_dns_lookup_promisified(
    args: runtime::JsArray<NativeValue>,
) -> runtime::JsPromise<NativeValue> {
    let values = runtime::array_values(&args);
    let hostname = values
        .first()
        .cloned()
        .map(native_value_string)
        .unwrap_or_else(|| runtime::string("undefined"));
    let options = values.get(1).cloned().unwrap_or(NativeValue::Undefined);
    let family_name = if matches!(options, NativeValue::Number(_)) {
        runtime::string("family")
    } else {
        runtime::string("options.family")
    };
    runtime::dns_lookup_promisified(
        &hostname,
        move || match options {
            NativeValue::Undefined | NativeValue::Null => 0.0,
            NativeValue::Number(family) => family,
            options => match native_value_get(options, runtime::string("family")) {
                NativeValue::Undefined | NativeValue::Null => 0.0,
                NativeValue::Number(family) => family,
                family => native_compare_number(&family),
            },
        },
        &family_name,
        |address, family| {
            native_dns_object(vec![
                (
                    runtime::string("address"),
                    address
                        .map(NativeValue::String)
                        .unwrap_or(NativeValue::Undefined),
                ),
                (runtime::string("family"), NativeValue::Number(family)),
            ])
        },
    )
}

fn native_dns_lookup_callback(
    hostname: runtime::JsString,
    options: NativeValue,
    callback: NativeValue,
) {
    let family = match &options {
        NativeValue::Undefined | NativeValue::Null => 0.0,
        NativeValue::Number(family) => *family,
        _ => match native_value_get(options.clone(), runtime::string("family")) {
            NativeValue::Undefined | NativeValue::Null => 0.0,
            NativeValue::Number(family) => family,
            family => native_compare_number(&family),
        },
    };
    let all = !matches!(options, NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_))
        && matches!(
            native_value_get(options.clone(), runtime::string("all")),
            NativeValue::Boolean(true)
        );
    let ipv4_first = !matches!(options, NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_))
        && matches!(
            native_value_get(options, runtime::string("order")),
            NativeValue::String(order) if order == "ipv4first"
        );
    runtime::dns_lookup_all(
        &hostname,
        family,
        ipv4_first,
        std::rc::Rc::new(move |result| match result {
            Ok(addresses) if all => {
                let values = addresses
                    .into_iter()
                    .map(|(address, family)| {
                        native_dns_object(vec![
                            (runtime::string("address"), NativeValue::String(address)),
                            (runtime::string("family"), NativeValue::Number(family)),
                        ])
                    })
                    .collect();
                let _ = native_value_call(
                    callback.clone(),
                    vec![
                        NativeValue::Null,
                        NativeValue::Array(runtime::array_new(values)),
                    ],
                    "dns.lookup callback",
                );
            }
            Ok(mut addresses) => {
                let (address, family) = addresses
                    .drain(..)
                    .next()
                    .expect("dns.lookup delivers a non-empty result");
                let _ = native_value_call(
                    callback.clone(),
                    vec![
                        NativeValue::Null,
                        NativeValue::String(address),
                        NativeValue::Number(family),
                    ],
                    "dns.lookup callback",
                );
            }
            Err(error) => {
                let _ = native_value_call(
                    callback.clone(),
                    vec![
                        native_caught(runtime::caught_value(error)),
                        NativeValue::Undefined,
                    ],
                    "dns.lookup callback",
                );
            }
        }),
    );
}

fn native_dns_resolve_record(
    hostname: runtime::JsString,
    record_type: u16,
    ttl: bool,
    reverse: bool,
) -> runtime::JsPromise<NativeValue> {
    let source = runtime::dns_resolve_record_promise(&hostname, record_type, ttl, reverse);
    runtime::promise_view_map(&source, native_dns_value)
}

fn native_dns_ttl_option(value: NativeValue) -> bool {
    if matches!(value, NativeValue::Undefined | NativeValue::Null) {
        return false;
    }
    matches!(
        native_value_get(value, runtime::string("ttl")),
        NativeValue::Boolean(true)
    )
}

fn native_dns_resolve_mx(hostname: runtime::JsString) -> runtime::JsPromise<NativeValue> {
    let source = runtime::dns_resolve_mx_promise(&hostname);
    runtime::promise_view_map(&source, |records| {
        let values = runtime::array_values(&records)
            .into_iter()
            .map(|record| {
                native_dns_object(vec![
                    (
                        runtime::string("priority"),
                        NativeValue::Number(record.priority),
                    ),
                    (
                        runtime::string("exchange"),
                        NativeValue::String(record.exchange),
                    ),
                ])
            })
            .collect();
        NativeValue::Array(runtime::array_new(values))
    })
}

fn native_dns_resolve_txt(hostname: runtime::JsString) -> runtime::JsPromise<NativeValue> {
    let source = runtime::dns_resolve_txt_promise(&hostname);
    runtime::promise_view_map(&source, |records| {
        let values = runtime::array_values(&records)
            .into_iter()
            .map(|record| {
                NativeValue::Array(runtime::array_new(
                    runtime::array_values(&record)
                        .into_iter()
                        .map(NativeValue::String)
                        .collect(),
                ))
            })
            .collect();
        NativeValue::Array(runtime::array_new(values))
    })
}
