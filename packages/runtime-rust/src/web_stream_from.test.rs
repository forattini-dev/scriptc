fn indexed_numbers(source: &JsArray<f64>, index: &Cell<usize>) -> Option<f64> {
    let position = index.get() as f64;
    if position >= array_len(source) { return None; }
    index.set(index.get() + 1);
    Some(array_get(source, position))
}

#[test]
fn web_stream_from_reads_live_items_without_prefetch_and_latches_eof() {
    let values = array_new(vec![1.0, 2.0]);
    let stream = web_stream_from_indexed(values.clone(), indexed_numbers, promise_resolved, 0.0);
    run_event_loop();
    assert_eq!(web_stream_desired_size(&stream), Some(0.0));
    array_set(&values, 0.0, 10.0);
    let reader = web_stream_get_reader(&stream);
    let first = web_reader_read(&reader);
    run_event_loop();
    assert!(matches!(promise_poll(&first), Some(Ok(Some(10.0)))));
    array_set(&values, 1.0, 20.0);
    let second = web_reader_read(&reader);
    run_event_loop();
    assert!(matches!(promise_poll(&second), Some(Ok(Some(20.0)))));
    let end = web_reader_read(&reader);
    run_event_loop();
    assert!(matches!(promise_poll(&end), Some(Ok(None))));
    array_push(&values, 30.0);
    let still_end = web_reader_read(&reader);
    assert!(matches!(promise_poll(&still_end), Some(Ok(None))));
    drop((values, stream, reader, first, second, end, still_end));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn web_stream_from_cancellation_settles_an_in_flight_read() {
    let stream = web_stream_from_indexed(array_new(vec![1.0]), indexed_numbers, promise_resolved, 0.0);
    run_event_loop();
    let reader = web_stream_get_reader(&stream);
    let read = web_reader_read(&reader);
    let cancelled = web_reader_cancel(&reader, 7.0);
    run_event_loop();
    assert!(matches!(promise_poll(&read), Some(Ok(None))));
    assert!(matches!(promise_poll(&cancelled), Some(Ok(()))));
    drop((stream, reader, read, cancelled));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn web_stream_from_propagates_an_iterator_value_rejection() {
    let stream = web_stream_from_indexed(array_new(vec![1.0]), indexed_numbers,
        |_| promise_rejected(caught_value(string("iterator failed"))), 0.0);
    let reader = web_stream_get_reader(&stream);
    let read = web_reader_read(&reader);
    run_event_loop();
    let Some(Err(error)) = promise_poll(&read) else { panic!("expected a rejected read"); };
    assert_eq!(caught_narrow::<JsString>(&error).as_ref(), "iterator failed");
    drop((stream, reader, read, error));
    finish();
    assert_eq!(live_heap_objects(), 0);
}
