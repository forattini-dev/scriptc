#[test]
fn fetch_reader_abandoned_cycle_is_collectable() {
    let request = fetch_response_new_text(&string("unread"));
    let reader = fetch_body_get_reader(&request);
    drop((request, reader));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn fetch_reader_preserves_demand_and_collects_cycles() {
    let request = fetch_response_new_text(&string("bytes"));
    let reader = fetch_body_get_reader(&request);
    assert!(fetch_body_locked(&request));
    assert!(!http_request_fetch_body_used(&request));
    assert!(request.with(|request| request.paused));
    let first = fetch_reader_read(&reader);
    run_event_loop();
    let Some(Ok(Some(bytes))) = promise_poll(&first) else { panic!("missing chunk"); };
    assert_eq!(bytes_u8_values(&bytes), b"bytes");
    assert!(request.with(|request| request.paused));
    let end = fetch_reader_read(&reader);
    run_event_loop();
    assert!(matches!(promise_poll(&end), Some(Ok(None))));
    fetch_reader_release(&reader);
    assert!(!fetch_body_locked(&request));
    drop((request, reader, first, end, bytes));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn fetch_reader_cancel_settles_pending_and_replacement_reads() {
    let request = fetch_response_new_text(&string("unread"));
    let reader = fetch_body_get_reader(&request);
    let first = fetch_reader_read(&reader);
    let second = fetch_reader_read(&reader);
    let cancelled = fetch_reader_cancel(&reader);
    assert!(matches!(promise_poll(&cancelled), Some(Ok(()))));
    assert!(matches!(promise_poll(&first), Some(Ok(None))));
    assert!(matches!(promise_poll(&second), Some(Ok(None))));
    assert!(http_request_fetch_body_used(&request));
    fetch_reader_release(&reader);
    let replacement = fetch_body_get_reader(&request);
    let end = fetch_reader_read(&replacement);
    assert!(matches!(promise_poll(&end), Some(Ok(None))));
    fetch_reader_release(&replacement);
    drop((request, reader, first, second, cancelled, replacement, end));
    finish();
    assert_eq!(live_heap_objects(), 0);
}
