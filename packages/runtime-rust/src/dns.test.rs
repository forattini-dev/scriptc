fn dns_test_node26() {
    target_configure(TargetConfig {
        runtime_id: "node26",
        node_version: "26.8.1",
        readable_bare_read: ReadRule::HeadChunk,
    });
}

fn dns_test_response(record_type: u16, ttl: u32, rdata: &[u8]) -> Vec<u8> {
    let mut packet = Vec::new();
    packet.extend_from_slice(&0x1234u16.to_be_bytes());
    packet.extend_from_slice(&0x8180u16.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    dns_encode_name("example.com", &mut packet).expect("valid test name");
    packet.extend_from_slice(&record_type.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    packet.extend_from_slice(&[0xc0, 0x0c]);
    packet.extend_from_slice(&record_type.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    packet.extend_from_slice(&ttl.to_be_bytes());
    packet.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
    packet.extend_from_slice(rdata);
    packet
}

#[test]
fn dns_record_parser_handles_addresses_ttl_and_compressed_names() {
    init();

    let address = dns_parse_response(
        &dns_test_response(1, 300, &[192, 0, 2, 1]),
        0x1234,
        DnsRecordKind::A,
    )
    .expect("A response");
    assert_eq!(
        match address {
            DnsRecords::Value(DnsValue::Array(values)) => values,
            _ => panic!("expected address array"),
        },
        vec![DnsValue::Object(vec![
            (
                string("address"),
                DnsValue::String(string("192.0.2.1")),
            ),
            (string("ttl"), DnsValue::Number(300.0)),
        ])]
    );

    let mx = dns_parse_response(
        &dns_test_response(
            15,
            60,
            &[0, 10, 4, b'm', b'a', b'i', b'l', 0xc0, 0x0c],
        ),
        0x1234,
        DnsRecordKind::Mx,
    )
    .expect("MX response");
    assert_eq!(
        match mx {
            DnsRecords::Mx(records) => records,
            _ => panic!("expected MX records"),
        },
        vec![DnsMxRecord {
            priority: 10.0,
            exchange: string("mail.example.com"),
        }]
    );

    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn dns_record_parser_preserves_txt_chunks_and_rejects_bad_packets() {
    init();

    let txt = dns_parse_response(
        &dns_test_response(16, 30, &[3, b'a', b'b', b'c', 2, b'd', b'e']),
        0x1234,
        DnsRecordKind::Txt,
    )
    .expect("TXT response");
    let records = match txt {
        DnsRecords::Txt(records) => records,
        _ => panic!("expected TXT records"),
    };
    assert_eq!(array_get(&records[0], 0.0), string("abc"));
    assert_eq!(array_get(&records[0], 1.0), string("de"));

    let mut truncated = dns_test_response(1, 1, &[127, 0, 0, 1]);
    truncated.pop();
    assert!(matches!(
        dns_parse_response(&truncated, 0x1234, DnsRecordKind::A),
        Err("BADRESP")
    ));
    assert!(matches!(
        dns_parse_response(
            &dns_test_response(1, 1, &[127, 0, 0, 1]),
            0xffff,
            DnsRecordKind::A
        ),
        Err("BADRESP")
    ));

    drop(records);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn dns_promises_preserve_literal_spelling_and_actual_family() {
    init();
    dns_test_node26();
    for (host, family, expected) in [
        ("127.0.0.1", 6.0, "127.0.0.1:4"),
        ("2001:0db8:0:0:0:0:0:1", 4.0, "2001:0db8:0:0:0:0:0:1:6"),
    ] {
        let promise = dns_lookup_promise(
            &string(host),
            || family,
            &string("family"),
            |address, family| string(&format!("{}:{family}", address.expect("literal address"))),
        );
        assert!(matches!(promise_poll(&promise), Some(Ok(value)) if value == string(expected)));
    }
    target_configure(PRIMARY_TARGET);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn dns_promises_empty_hostname_follows_the_selected_runtime() {
    init();
    target_configure(PRIMARY_TARGET);
    let legacy = dns_lookup_promise(
        &empty_string(),
        || 6.0,
        &string("options.family"),
        |address, family| {
            assert!(address.is_none());
            family
        },
    );
    assert!(matches!(promise_poll(&legacy), Some(Ok(6.0))));
    dns_test_node26();
    let modern: JsPromise<f64> =
        dns_lookup_promise(&empty_string(), || 6.0, &string("options.family"), |_, _| {
            panic!("invalid hostname must reject")
        });
    // Attach a rejection handler so this unit test does not leave an unhandled rejection.
    promise_then(
        &modern,
        Box::new(|outcome| {
            let error = outcome.expect_err("empty hostname must reject");
            assert_eq!(
                caught_error_code(&error).as_deref(),
                Some("ERR_INVALID_ARG_VALUE")
            );
            assert_eq!(
                caught_error_message(&error).as_ref(),
                "The argument 'hostname' must be a non-empty string. Received ''"
            );
        }),
    );
    run_event_loop();
    drop((legacy, modern));
    target_configure(PRIMARY_TARGET);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn dns_promises_null_byte_validation_precedes_family_on_node26() {
    init();
    dns_test_node26();
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = dns_lookup_promise(
            &string("bad\0host"),
            || 5.0,
            &string("options.family"),
            |_, _| 0.0,
        );
    }))
    .expect_err("null bytes must throw before returning a promise");
    let caught = caught_from_panic(error);
    assert_eq!(
        caught_error_code(&caught).as_deref(),
        Some("ERR_INVALID_ARG_VALUE")
    );
    assert!(
        caught_error_message(&caught)
            .as_ref()
            .contains("without null bytes")
    );
    drop(caught);
    target_configure(PRIMARY_TARGET);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn dns_promisified_literals_are_pending_until_next_tick() {
    init();
    dns_test_node26();
    let pending = dns_lookup_promisified(&string("::1"), || 4.0, &string("family"), |address, family| {
        assert_eq!(address, Some(string("::1")));
        family
    });
    assert!(promise_poll(&pending).is_none());
    run_event_loop();
    assert!(matches!(promise_poll(&pending), Some(Ok(6.0))));
    drop(pending);
    target_configure(PRIMARY_TARGET);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn dns_promisified_validation_rejects_without_reading_family_before_hostname() {
    init();
    dns_test_node26();
    let result = dns_lookup_promisified(&string("bad\0host"), || panic!("family must not be read"),
        &string("options.family"), |_, _| 0.0);
    promise_then(&result, Box::new(|outcome| {
        let error = outcome.expect_err("validation must reject inside the executor");
        assert_eq!(caught_error_code(&error).as_deref(), Some("ERR_INVALID_ARG_VALUE"));
        assert!(caught_error_message(&error).as_ref().contains("without null bytes"));
    }));
    run_event_loop();
    drop(result);
    target_configure(PRIMARY_TARGET);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
