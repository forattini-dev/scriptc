#[test]
fn web_text_decoder_stream_preserves_split_utf8_chunks() {
    let source = web_stream_new(Rc::new(EmptyWebStreamSource {
        empty: bytes_empty::<u8>(),
    }));
    web_stream_enqueue(&source, bytes_from_vec(vec![b'A', 0xf0, 0x9f]));
    web_stream_enqueue(&source, bytes_from_vec(vec![0x98, 0x80, b'B']));
    web_stream_close(&source);

    let decoded = web_text_decoder_stream(&source, text_decoder_new());
    let reader = web_stream_get_reader(&decoded);
    let first_promise = web_reader_read(&reader);
    run_event_loop();
    let Some(Ok(Some(first_text))) = promise_poll(&first_promise) else { panic!("missing first text chunk"); };
    assert_eq!(first_text.as_ref(), "A");
    let second_promise = web_reader_read(&reader);
    run_event_loop();
    let Some(Ok(Some(second_text))) = promise_poll(&second_promise) else { panic!("missing second text chunk"); };
    assert_eq!(second_text.as_ref(), "😀B");
    let done = web_reader_read(&reader);
    run_event_loop();
    assert!(matches!(promise_poll(&done), Some(Ok(None))));
    web_reader_release(&reader);
    drop((source, decoded, reader, first_promise, second_promise, done, first_text, second_text));
    finish();
    assert_eq!(live_heap_objects(), 0);
}
