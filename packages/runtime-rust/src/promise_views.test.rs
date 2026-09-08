#[test]
fn promise_views_preserve_identity_order_and_pending_settlement() {
    init();
    let baseline = live_heap_objects();
    {
        let source = promise_new::<f64>();
        let handle = promise_to_mapped_handle(&source, |value| value + 1.0);
        let view = promise_view_from_handle::<f64>(&handle);
        let mapped = promise_view_map(&view, |value| value * 2.0);
        assert_eq!(promise_view_identity(&mapped), source.identity());
        assert_eq!(
            promise_handle_identity(&promise_to_handle(&mapped)),
            source.identity()
        );
        assert!(promise_poll(&view).is_none());
        assert!(!promise_fulfill(&view, 99.0));
        let order = Rc::new(RefCell::new(Vec::new()));
        let seen = order.clone();
        promise_then(
            &mapped,
            Box::new(move |outcome| {
                assert!(matches!(outcome, Ok(8.0)));
                seen.borrow_mut().push("view");
            }),
        );
        let seen = order.clone();
        promise_then(&source, Box::new(move |_| seen.borrow_mut().push("source")));
        assert!(promise_fulfill(&source, 3.0));
        assert!(matches!(promise_poll(&mapped), Some(Ok(8.0))));
        let seen = order.clone();
        timer_queue_microtask(Box::new(move || seen.borrow_mut().push("tick")));
        assert!(order.borrow().is_empty());
        run_event_loop();
        assert_eq!(*order.borrow(), ["view", "source", "tick"]);
    }
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn promise_views_do_not_hide_unhandled_rejections_or_replace_their_identity() {
    init();
    let baseline = live_heap_objects();
    {
        let source = promise_new::<f64>();
        let handle = promise_to_handle(&source);
        let view = promise_view_from_handle::<f64>(&handle);
        let reported = Rc::new(Cell::new(0));
        let seen = reported.clone();
        promise_set_unhandled_rejection_handler(Some(Rc::new(move |_, handle| {
            seen.set(promise_handle_identity(&handle));
        })));
        let reason = error_new("Error", string("shared"));
        promise_reject(&source, caught_value(reason.clone()));
        run_event_loop();
        assert_eq!(reported.get(), source.identity());
        let outcome = promise_poll(&view).unwrap().unwrap_err();
        assert_eq!(
            error_identity(&caught_narrow::<JsError>(&outcome)),
            error_identity(&reason)
        );
        promise_set_unhandled_rejection_handler(None);
    }
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn promise_view_mapping_errors_reject_the_observer_without_unwinding_the_loop() {
    init();
    let baseline = live_heap_objects();
    {
        let source = promise_resolved(1.0);
        let view = promise_view_map(&source, |_| -> f64 {
            throw_type_error("invalid payload".to_owned());
        });
        let observed = Rc::new(Cell::new(false));
        let seen = observed.clone();
        promise_then(
            &view,
            Box::new(move |outcome| {
                seen.set(outcome.is_err());
            }),
        );
        run_event_loop();
        assert!(observed.get());
        assert!(matches!(promise_poll(&view), Some(Err(_))));
        assert!(matches!(promise_poll(&source), Some(Ok(1.0))));
    }
    finish();
    assert_eq!(live_heap_objects(), baseline);
}
