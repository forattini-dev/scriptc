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
