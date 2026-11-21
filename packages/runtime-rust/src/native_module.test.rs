struct ModuleWaitTestFrame {
    order: Rc<RefCell<Vec<&'static str>>>,
    body: Option<JsPromise<()>>,
    dependency: Option<JsPromise<()>>,
}

impl Trace for ModuleWaitTestFrame {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(body) = &self.body { tracer.edge(body); }
        if let Some(dependency) = &self.dependency { tracer.edge(dependency); }
    }
}

impl ClearEdges for ModuleWaitTestFrame {
    fn clear_edges(&mut self) { self.body = None; self.dependency = None; }
}

fn start_wait_test_module(frame: Gc<ModuleWaitTestFrame>) -> JsPromise<()> {
    frame.with(|frame| {
        frame.order.borrow_mut().push("body");
        frame.body.clone().expect("test body promise")
    })
}

#[test]
fn native_module_waits_for_all_dependencies_and_body() {
    init();
    let order = Rc::new(RefCell::new(Vec::new()));
    let first = promise_new();
    let second = promise_new();
    let body = promise_new();
    let frame = Gc::new(ModuleWaitTestFrame { order: order.clone(), body: Some(body.clone()), dependency: None });
    let evaluation = module_evaluate_after(&[first.clone(), second.clone()], frame, start_wait_test_module);
    let observed = order.clone();
    promise_then(&evaluation, Box::new(move |outcome| {
        assert!(outcome.is_ok());
        observed.borrow_mut().push("evaluated");
    }));
    promise_fulfill(&second, ());
    run_event_loop();
    assert!(order.borrow().is_empty());
    assert!(promise_poll(&evaluation).is_none());
    promise_fulfill(&first, ());
    run_event_loop();
    assert_eq!(*order.borrow(), ["body"]);
    assert!(promise_poll(&evaluation).is_none());
    promise_fulfill(&body, ());
    run_event_loop();
    assert_eq!(*order.borrow(), ["body", "evaluated"]);
    drop((first, second, body, evaluation));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_dependency_rejection_skips_body_and_preserves_reason() {
    init();
    let order = Rc::new(RefCell::new(Vec::new()));
    let first = promise_new();
    let second = promise_new();
    let body = promise_new();
    let frame = Gc::new(ModuleWaitTestFrame { order: order.clone(), body: Some(body.clone()), dependency: None });
    let evaluation = module_evaluate_after(&[first.clone(), second.clone()], frame, start_wait_test_module);
    let reason = caught_value(string("dependency failed"));
    let expected = reason.clone();
    promise_then(&evaluation, Box::new(move |outcome| {
        let actual = outcome.expect_err("module must reject");
        assert!(Rc::ptr_eq(&actual.value, &expected.value));
    }));
    promise_reject(&first, reason.clone());
    run_event_loop();
    assert!(order.borrow().is_empty());
    promise_fulfill(&second, ());
    run_event_loop();
    assert!(order.borrow().is_empty());
    assert!(!had_unhandled_rejection());
    drop((first, second, body, evaluation, reason));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_wait_cycle_is_collectible() {
    init();
    let dependency = promise_new();
    let weak = dependency.downgrade();
    let frame = Gc::new(ModuleWaitTestFrame {
        order: Rc::new(RefCell::new(Vec::new())),
        body: None,
        dependency: Some(dependency.clone()),
    });
    let evaluation = module_evaluate_after(std::slice::from_ref(&dependency), frame, start_wait_test_module);
    drop((dependency, evaluation));
    collect_cycles();
    assert!(weak.upgrade().is_none());
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_wait_propagates_body_rejection() {
    init();
    let dependency = promise_new();
    let body = promise_new();
    let order = Rc::new(RefCell::new(Vec::new()));
    let frame = Gc::new(ModuleWaitTestFrame { order: order.clone(), body: Some(body.clone()), dependency: None });
    let evaluation = module_evaluate_after(std::slice::from_ref(&dependency), frame, start_wait_test_module);
    let reason = caught_value(string("body failed"));
    let expected = reason.clone();
    promise_then(&evaluation, Box::new(move |outcome| {
        assert!(Rc::ptr_eq(&outcome.expect_err("module must reject").value, &expected.value));
    }));
    promise_fulfill(&dependency, ());
    run_event_loop();
    assert_eq!(*order.borrow(), ["body"]);
    promise_reject(&body, reason.clone());
    run_event_loop();
    assert!(!had_unhandled_rejection());
    drop((dependency, body, evaluation, reason));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_import_waits_for_nested_microtasks() {
    init();
    let order = Rc::new(RefCell::new(Vec::new()));
    let loaded = order.clone();
    let imported = module_import(move || {
        loaded.borrow_mut().push("module");
        promise_resolved(7.0)
    });
    assert!(order.borrow().is_empty());
    let queued = order.clone();
    timer_queue_microtask(Box::new(move || {
        queued.borrow_mut().push("microtask");
        timer_queue_microtask(Box::new(move || queued.borrow_mut().push("nested")));
    }));
    let observed = order.clone();
    promise_then(
        &imported,
        Box::new(move |result| {
            assert!(matches!(result, Ok(7.0)));
            observed.borrow_mut().push("imported");
        }),
    );
    run_event_loop();
    assert_eq!(
        *order.borrow(),
        ["microtask", "nested", "module", "imported"]
    );
    drop(imported);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_import_adopts_shared_evaluation_with_distinct_promises() {
    init();
    let evaluation = promise_new();
    let first_source = evaluation.clone();
    let second_source = evaluation.clone();
    let first = module_import(move || first_source);
    let second = module_import(move || second_source);
    assert_ne!(first.identity(), second.identity());
    run_event_loop();
    assert!(promise_poll(&first).is_none());
    assert!(promise_poll(&second).is_none());
    let namespace = array_new(vec![3.0]);
    promise_fulfill(&evaluation, namespace.clone());
    run_event_loop();
    let a = promise_unwrap(promise_poll(&first).expect("first import settled"));
    let b = promise_unwrap(promise_poll(&second).expect("second import settled"));
    assert_eq!(a.identity(), namespace.identity());
    assert_eq!(a.identity(), b.identity());
    drop((evaluation, first, second, namespace, a, b));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_cache_evaluates_once_and_shares_namespace() {
    init();
    let cache = module_cache_new();
    let runs = Rc::new(Cell::new(0));
    let namespace = array_new(vec![3.0]);
    let value = namespace.clone();
    let count = runs.clone();
    let first = module_import_cached(cache.clone(), move || {
        count.set(count.get() + 1);
        promise_resolved(value)
    });
    let count = runs.clone();
    let second = module_import_cached(cache.clone(), move || {
        count.set(count.get() + 1);
        promise_resolved(array_new(vec![9.0]))
    });
    assert_eq!(runs.get(), 0);
    assert_ne!(first.identity(), second.identity());
    run_event_loop();
    assert_eq!(runs.get(), 1);
    let a = promise_unwrap(promise_poll(&first).unwrap());
    let b = promise_unwrap(promise_poll(&second).unwrap());
    assert_eq!(a.identity(), namespace.identity());
    assert_eq!(a.identity(), b.identity());
    let count = runs.clone();
    let third = module_import_cached(cache.clone(), move || {
        count.set(count.get() + 1);
        promise_resolved(array_new(vec![10.0]))
    });
    run_event_loop();
    assert_eq!(runs.get(), 1);
    let c = promise_unwrap(promise_poll(&third).unwrap());
    assert_eq!(c.identity(), namespace.identity());
    drop((cache, first, second, third, namespace, a, b, c));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_cache_retains_thrown_failure() {
    init();
    let cache = module_cache_new();
    let reason = caught_value(string("failed"));
    let thrown = reason.clone();
    let first = module_import_cached::<(), _>(cache.clone(), move || rethrow_caught(thrown));
    let expected = reason.clone();
    promise_then(&first, Box::new(move |outcome| {
        assert!(Rc::ptr_eq(&outcome.expect_err("first import").value, &expected.value));
    }));
    run_event_loop();
    let second = module_import_cached(cache.clone(), || promise_resolved(()));
    let expected = reason.clone();
    promise_then(&second, Box::new(move |outcome| {
        assert!(Rc::ptr_eq(&outcome.expect_err("cached import").value, &expected.value));
    }));
    run_event_loop();
    assert!(!had_unhandled_rejection());
    drop((cache, first, second, reason));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_cache_shares_pending_rejection() {
    init();
    let cache = module_cache_new();
    let source = promise_new::<()>();
    let pending = source.clone();
    let first = module_import_cached(cache.clone(), move || pending);
    let second = module_import_cached(cache.clone(), || panic!("initializer ran twice"));
    let reason = caught_value(string("async failure"));
    for imported in [&first, &second] {
        let expected = reason.clone();
        promise_then(imported, Box::new(move |outcome| {
            assert!(Rc::ptr_eq(&outcome.expect_err("import rejects").value, &expected.value));
        }));
    }
    run_event_loop();
    assert!(promise_poll(&first).is_none());
    assert!(promise_poll(&second).is_none());
    promise_reject(&source, reason.clone());
    run_event_loop();
    assert!(!had_unhandled_rejection());
    drop((cache, source, first, second, reason));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_cache_maps_multiple_import_sites_after_one_evaluation() {
    init();
    let cache = module_cache_new();
    let runs = Rc::new(Cell::new(0));
    let count = runs.clone();
    let first = module_import_cached_map(cache.clone(), move || {
        count.set(count.get() + 1);
        promise_resolved(())
    }, |_| string("first"));
    let count = runs.clone();
    let second = module_import_cached_map(cache.clone(), move || {
        count.set(count.get() + 1);
        promise_resolved(())
    }, |_| 42.0);
    assert_eq!(runs.get(), 0);
    run_event_loop();
    assert_eq!(runs.get(), 1);
    assert_eq!(promise_unwrap(promise_poll(&first).unwrap()), string("first"));
    assert_eq!(promise_unwrap(promise_poll(&second).unwrap()), 42.0);
    drop((cache, first, second));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_sync_cache_preserves_reentrant_and_failure_behavior() {
    init();
    let evaluation = promise_new();
    let ran = Cell::new(false);
    module_evaluate_sync(&evaluation, || {
        module_cached_sync(&evaluation);
        ran.set(true);
    });
    assert!(ran.get());
    assert!(matches!(promise_poll(&evaluation), Some(Ok(()))));
    module_cached_sync(&evaluation);

    let failed = promise_new();
    let original = caught_value(Rc::new(Cell::new(11)));
    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        module_evaluate_sync(&failed, || rethrow_caught(original.clone()));
    }));
    let first = caught_from_panic(attempt.expect_err("evaluation throws"));
    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        module_cached_sync(&failed);
    }));
    let again = caught_from_panic(attempt.expect_err("cached evaluation throws"));
    assert!(Rc::ptr_eq(&first.value, &original.value));
    assert!(Rc::ptr_eq(&again.value, &original.value));
    run_event_loop();
    assert!(!had_unhandled_rejection());
    drop((evaluation, failed, original, first, again));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_import_rejects_load_throws_and_shared_failures() {
    init();
    let original = caught_value(string("module failed"));
    let thrown = original.clone();
    let failed = module_import::<(), _>(move || rethrow_caught(thrown));
    let reason = original.clone();
    promise_then(
        &failed,
        Box::new(move |outcome| match outcome {
            Err(error) => assert!(Rc::ptr_eq(&error.value, &reason.value)),
            Ok(()) => panic!("throwing module must reject"),
        }),
    );
    let rejected = promise_rejected::<()>(original.clone());
    let source = rejected.clone();
    let imported = module_import(move || source);
    let reason = original.clone();
    promise_then(
        &imported,
        Box::new(move |outcome| match outcome {
            Err(error) => assert!(Rc::ptr_eq(&error.value, &reason.value)),
            Ok(()) => panic!("rejected module must reject"),
        }),
    );
    run_event_loop();
    assert!(!had_unhandled_rejection());
    drop((original, failed, rejected, imported));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn native_module_teardown_drops_queued_loaders_without_running_them() {
    init();
    let ran = Rc::new(Cell::new(false));
    let called = ran.clone();
    let namespace = array_new(vec![1.0]);
    let pending = module_import(move || {
        called.set(true);
        promise_resolved(namespace)
    });
    drop(pending);
    finish();
    assert!(!ran.get());
    assert_eq!(live_heap_objects(), 0);
}
