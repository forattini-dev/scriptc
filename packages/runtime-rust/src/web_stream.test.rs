struct TestWebSource { pulls: Rc<Cell<usize>> }
impl Trace for TestWebSource { fn trace(&self, _: &mut Tracer<'_>) {} }
impl WebStreamSource<f64> for TestWebSource {
    fn has_pull(&self) -> bool { true }
    fn pull(&self, stream: &JsWebStream<f64>) -> JsPromise<f64> {
        let next = self.pulls.get() + 1;
        self.pulls.set(next);
        web_stream_enqueue(stream, next as f64);
        promise_resolved(0.0)
    }
    fn cancel(&self, _: f64) -> JsPromise<f64> { promise_resolved(0.0) }
}

#[test]
fn web_stream_start_gates_pulls_and_one_entry_backpressure() {
    let pulls = Rc::new(Cell::new(0));
    let stream = web_stream_new(Rc::new(TestWebSource { pulls: pulls.clone() }));
    let start = promise_new();
    web_stream_start(&stream, &start);
    run_event_loop();
    assert_eq!(pulls.get(), 0);
    promise_fulfill(&start, 0.0);
    run_event_loop();
    assert_eq!(pulls.get(), 1);
    assert_eq!(web_stream_desired_size(&stream), Some(0.0));
    let reader = web_stream_get_reader(&stream);
    let first = web_reader_read(&reader);
    run_event_loop();
    assert!(matches!(promise_poll(&first), Some(Ok(Some(1.0)))));
    assert_eq!(pulls.get(), 2);
    web_stream_close(&stream);
    let second = web_reader_read(&reader);
    let done = web_reader_read(&reader);
    assert!(matches!(promise_poll(&second), Some(Ok(Some(2.0)))));
    assert!(matches!(promise_poll(&done), Some(Ok(None))));
    web_reader_release(&reader);
    drop((stream, reader, first, second, done, start));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn web_stream_release_rejects_pending_without_unlocking_replacement() {
    let stream = web_stream_new(Rc::new(TestWebSource { pulls: Rc::new(Cell::new(0)) }));
    let reader = web_stream_get_reader(&stream);
    let pending = web_reader_read(&reader);
    web_reader_release(&reader);
    assert!(matches!(promise_poll(&pending), Some(Err(_))));
    let replacement = web_stream_get_reader(&stream);
    web_reader_release(&reader);
    assert!(web_stream_locked(&stream));
    drop((stream, reader, replacement, pending));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn web_stream_retains_lock_until_release_and_collects_abandoned_cycle() {
    let stream = web_stream_new(Rc::new(TestWebSource { pulls: Rc::new(Cell::new(0)) }));
    let reader = web_stream_get_reader(&stream);
    drop(reader);
    collect_cycles();
    assert!(web_stream_locked(&stream));
    drop(stream);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn web_stream_source_controller_cycle_is_collectable() {
    struct CyclicSource { controller: JsCell<Option<JsWebStream<f64>>> }
    impl Trace for CyclicSource { fn trace(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.controller); } }
    impl WebStreamSource<f64> for CyclicSource {
        fn has_pull(&self) -> bool { false }
        fn pull(&self, _: &JsWebStream<f64>) -> JsPromise<f64> { promise_resolved(0.0) }
        fn cancel(&self, _: f64) -> JsPromise<f64> { promise_resolved(0.0) }
    }
    let cell = cell_new(None);
    let stream = web_stream_new(Rc::new(CyclicSource { controller: cell.clone() }));
    cell_set(&cell, Some(stream.clone()));
    drop((cell, stream));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn web_reader_closed_tracks_drain_and_replaces_capability_after_release() {
    let stream = web_stream_new(Rc::new(TestWebSource { pulls: Rc::new(Cell::new(0)) }));
    web_stream_enqueue(&stream, 9.0);
    web_stream_close(&stream);
    let reader = web_stream_get_reader(&stream);
    let closed = web_reader_closed(&reader);
    assert_eq!(closed.identity(), web_reader_closed(&reader).identity());
    assert!(promise_poll(&closed).is_none());
    let read = web_reader_read(&reader);
    assert!(matches!(promise_poll(&read), Some(Ok(Some(9.0)))));
    assert!(matches!(promise_poll(&closed), Some(Ok(()))));
    web_reader_release(&reader);
    let released = web_reader_closed(&reader);
    assert_ne!(closed.identity(), released.identity());
    assert!(matches!(promise_poll(&released), Some(Err(_))));
    assert!(matches!(promise_poll(&closed), Some(Ok(()))));
    drop((stream, reader, closed, read, released));
    finish();
    assert_eq!(live_heap_objects(), 0);
}
