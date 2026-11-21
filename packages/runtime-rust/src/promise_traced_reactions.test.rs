struct TracedAwaitFrame {
    source: Option<JsPromise<f64>>,
    seen: Rc<RefCell<Vec<f64>>>,
}
impl Trace for TracedAwaitFrame {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(source) = &self.source { tracer.edge(source); }
    }
}
impl ClearEdges for TracedAwaitFrame {
    fn clear_edges(&mut self) { self.source = None; }
}
fn record_traced_await(frame: Gc<TracedAwaitFrame>, outcome: Result<f64, Caught>) {
    let Ok(value) = outcome else { panic!("expected a fulfilled promise") };
    frame.with(|frame| frame.seen.borrow_mut().push(value));
}
fn record_traced_rejection(frame: Gc<TracedAwaitFrame>, outcome: Result<f64, Caught>) {
    let Err(reason) = outcome else { panic!("expected a rejected promise") };
    assert_eq!(caught_narrow::<JsString>(&reason), string("rejected"));
    frame.with(|frame| frame.seen.borrow_mut().push(1.0));
}

#[test]
fn traced_promise_reaction_retains_frame_until_the_microtask_runs() {
    init();
    let baseline = live_heap_objects();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let source = promise_new::<f64>();
    let frame = Gc::new(TracedAwaitFrame { source: Some(source.clone()), seen: seen.clone() });
    promise_then_traced(&source, frame, record_traced_await);
    assert!(promise_fulfill(&source, 7.0));
    drop(source);
    collect_cycles();
    assert!(seen.borrow().is_empty());
    run_event_loop();
    assert_eq!(*seen.borrow(), vec![7.0]);
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn traced_pending_reaction_cycle_is_collectible() {
    init();
    let baseline = live_heap_objects();
    let source = promise_new::<f64>();
    let frame = Gc::new(TracedAwaitFrame { source: Some(source.clone()), seen: Rc::new(RefCell::new(Vec::new())) });
    let source_weak = source.downgrade();
    let frame_weak = frame.downgrade();
    promise_then_traced(&source, frame, record_traced_await);
    drop(source);
    collect_cycles();
    assert!(source_weak.upgrade().is_none());
    assert!(frame_weak.upgrade().is_none());
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn traced_reaction_on_mapped_view_preserves_mapping_and_collects() {
    init();
    let baseline = live_heap_objects();
    {
        let source = promise_new::<f64>();
        let view = promise_view_from_handle::<f64>(&promise_to_mapped_handle(&source, |value| value + 1.0));
        let seen = Rc::new(RefCell::new(Vec::new()));
        let frame = Gc::new(TracedAwaitFrame { source: Some(view.clone()), seen: seen.clone() });
        promise_then_traced(&view, frame, record_traced_await);
        assert!(promise_fulfill(&source, 4.0));
        run_event_loop();
        assert_eq!(*seen.borrow(), vec![5.0]);
    }
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn traced_pending_view_reaction_cycle_is_collectible() {
    init();
    let baseline = live_heap_objects();
    let source = promise_new::<f64>();
    let view = promise_view_from_handle::<f64>(&promise_to_mapped_handle(&source, |value| value));
    let frame = Gc::new(TracedAwaitFrame { source: Some(view.clone()), seen: Rc::new(RefCell::new(Vec::new())) });
    let weak = frame.downgrade();
    promise_then_traced(&view, frame, record_traced_await);
    drop(view);
    drop(source);
    collect_cycles();
    assert!(weak.upgrade().is_none());
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn traced_reaction_through_nested_views_delivers_rejection() {
    init();
    let baseline = live_heap_objects();
    {
        let source = promise_new::<f64>();
        let view = promise_view_from_handle::<f64>(&promise_to_mapped_handle(&source, |value| value + 1.0));
        let nested = promise_view_map(&view, |value| value * 2.0);
        let seen = Rc::new(RefCell::new(Vec::new()));
        let frame = Gc::new(TracedAwaitFrame { source: Some(nested.clone()), seen: seen.clone() });
        promise_then_traced(&nested, frame, record_traced_rejection);
        assert!(promise_reject(&source, caught_value(string("rejected"))));
        run_event_loop();
        assert_eq!(*seen.borrow(), vec![1.0]);
    }
    finish();
    assert_eq!(live_heap_objects(), baseline);
}
