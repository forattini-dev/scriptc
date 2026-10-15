#[cfg(unix)]
#[test]
fn bun_pipe_identity_response_consumption_and_heap() {
    let _guard = loop_deadline(DEADLINE_MS);
    let argv = array_new(vec![string("/bin/sh"), string("-c"), string("printf hello; printf error >&2")]);
    let child = bun_spawn(&argv, 0.0, 2.0, 2.0, false, &array_new(vec![]), &empty_string());
    let empty = bytes_from_vec(vec![]);
    let stdout = bun_subprocess_output(&child, false, |b| b, empty.clone()).unwrap();
    assert!(stdout.ptr_eq(&bun_subprocess_output(&child, false, |b| b, empty.clone()).unwrap()));
    let stderr = bun_subprocess_output(&child, true, |b| b, empty).unwrap();
    let response = fetch_response_new_stream(&stdout, |b| b);
    assert!(fetch_response_web_body::<JsBytes<u8>>(&response).unwrap().ptr_eq(&stdout));
    assert!(!http_request_fetch_body_used(&response));
    let text = fetch_response_text(&response);
    let error = fetch_response_text(&fetch_response_new_stream(&stderr, |b| b));
    assert!(web_stream_locked(&stdout));
    assert!(http_request_fetch_body_used(&response));
    run_event_loop();
    assert!(matches!(promise_poll(&text), Some(Ok(value)) if value == string("hello")));
    assert!(matches!(promise_poll(&error), Some(Ok(value)) if value == string("error")));
    let duplicate = fetch_response_text(&response);
    let _ = promise_poll(&duplicate);
    run_event_loop();
    assert!(matches!(promise_poll(&duplicate), Some(Err(_))));
    drop((argv, child, stdout, stderr, response, text, error, duplicate));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn bun_pipe_does_not_drain_without_demand_and_cancel_releases_pending() {
    let pipe = child_stream_husk();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    pipe.with_mut(|s| s.receiver = Some(receiver));
    sender.try_send(ChildPipeEvent::Data(vec![7])).unwrap();
    assert!(child_stream_poll(&pipe).is_none());
    assert!(sender.try_send(ChildPipeEvent::Data(vec![8])).is_err());
    let empty = bytes_from_vec(vec![]);
    let stream = web_stream_new_with_prefetch(Rc::new(BunPipeSource { pipe: pipe.clone(), project: |b| b, empty: empty.clone() }), false);
    web_stream_start(&stream, &promise_resolved(empty));
    run_event_loop();
    assert!(pipe.with(|s| s.web_pull.is_none()));
    let reader = web_stream_get_reader(&stream);
    let first = web_reader_read(&reader);
    assert!(!child_stream_dispatch(&pipe, child_stream_poll(&pipe).unwrap()));
    run_event_loop();
    assert!(matches!(promise_poll(&first), Some(Ok(Some(bytes))) if bytes_u8_values(&bytes) == vec![7]));
    let pending = web_reader_read(&reader);
    let cancelled = web_reader_cancel(&reader, bytes_from_vec(vec![]));
    run_event_loop();
    assert!(matches!(promise_poll(&pending), Some(Ok(None))));
    assert!(matches!(promise_poll(&cancelled), Some(Ok(()))));
    assert!(sender.try_send(ChildPipeEvent::Data(vec![9])).is_err());
    drop((pipe, sender, stream, reader, first, pending, cancelled));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn bun_pipe_read_failure_rejects_the_body() {
    let pipe = child_stream_husk();
    let source = Rc::new(BunPipeSource { pipe: pipe.clone(), project: |b| b, empty: bytes_from_vec(vec![]) });
    let stream = web_stream_new_with_prefetch(source, false);
    web_stream_start(&stream, &promise_resolved(bytes_from_vec(vec![])));
    run_event_loop();
    let response = fetch_response_new_stream(&stream, |b| b);
    let text = fetch_response_text(&response);
    child_stream_dispatch(&pipe, ChildPipeEvent::Error("fixture read failure".to_owned()));
    run_event_loop();
    assert!(matches!(promise_poll(&text), Some(Err(error)) if caught_error_message(&error) == string("fixture read failure")));
    drop((pipe, stream, response, text));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn bun_pipe_initial_failure_is_not_silently_converted_to_eof() {
    let pipe = child_stream_husk();
    pipe.with_mut(|s| { s.eof = true; s.read_error = Some("worker failed".to_owned()); });
    let source = Rc::new(BunPipeSource { pipe: pipe.clone(), project: |b| b, empty: bytes_from_vec(vec![]) });
    let stream = web_stream_new_with_prefetch(source, false);
    web_stream_start(&stream, &promise_resolved(bytes_from_vec(vec![])));
    let response = fetch_response_new_stream(&stream, |b| b);
    let text = fetch_response_text(&response);
    let _ = promise_poll(&text);
    run_event_loop();
    assert!(matches!(promise_poll(&text), Some(Err(error)) if caught_error_message(&error) == string("worker failed")));
    drop((pipe, stream, response, text));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn bun_pipe_cached_stream_cycle_is_collectable() {
    let pipe = child_stream_husk();
    let source = Rc::new(BunPipeSource { pipe: pipe.clone(), project: |b| b, empty: bytes_from_vec(vec![]) });
    let stream = web_stream_new_with_prefetch(source, false);
    pipe.with_mut(|s| s.web_cache = Some(Box::new(ChildWebStream(stream.clone()))));
    drop((pipe, stream));
    collect_cycles();
    finish();
    assert_eq!(live_heap_objects(), 0);
}
