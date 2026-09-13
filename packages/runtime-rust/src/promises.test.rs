#[derive(Clone, Debug)]
struct RestrictedPromiseValue {
    restricted: bool,
    checks: Rc<Cell<usize>>,
}

impl HeapValue for RestrictedPromiseValue {
    fn promise_resolution_error(&self) -> Option<&'static str> {
        self.checks.set(self.checks.get() + 1);
        self.restricted.then_some("unsupported test thenable")
    }
}

impl ArrayElement for RestrictedPromiseValue {}

#[test]
fn promise_resolution_refusals_reject_and_schedule_existing_reactions() {
    init();
    let checks = Rc::new(Cell::new(0));
    let value = RestrictedPromiseValue { restricted: true, checks: checks.clone() };
    let resolved = promise_resolved(value.clone());
    let pending = promise_new();
    let seen = Rc::new(RefCell::new(Vec::new()));
    for (name, promise) in [("resolved", &resolved), ("pending", &pending)] {
        let seen = seen.clone();
        promise_then(promise, Box::new(move |outcome| {
            let reason = outcome.expect_err("unsupported value must reject");
            let error = caught_narrow::<JsError>(&reason);
            assert_eq!(error_name(&error).as_ref(), "Error");
            assert_eq!(error_message(&error).as_ref(), "unsupported test thenable");
            seen.borrow_mut().push(name);
        }));
    }
    assert!(promise_fulfill(&pending, value));
    assert_eq!(checks.get(), 2);
    assert!(seen.borrow().is_empty());
    run_event_loop();
    assert_eq!(*seen.borrow(), ["resolved", "pending"]);
    drop((resolved, pending));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn promise_resolution_does_not_inspect_ignored_settlements_or_views() {
    init();
    let checks = Rc::new(Cell::new(0));
    let value = RestrictedPromiseValue { restricted: false, checks: checks.clone() };
    let source = promise_new();
    let view = promise_view_map(&source, |value| value);
    assert!(!promise_fulfill(&view, value.clone()));
    assert_eq!(checks.get(), 0);
    assert!(promise_fulfill(&source, value.clone()));
    assert_eq!(checks.get(), 1);
    assert!(!promise_fulfill(&source, RestrictedPromiseValue { restricted: true, ..value }));
    assert_eq!(checks.get(), 1);
    assert!(matches!(promise_poll(&source), Some(Ok(_))));
    drop((source, view));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn promise_resolution_checks_optional_values_but_not_array_children() {
    init();
    let checks = Rc::new(Cell::new(0));
    let value = RestrictedPromiseValue { restricted: true, checks: checks.clone() };
    let some = promise_resolved(Some(value.clone()));
    promise_then(&some, Box::new(|outcome| assert!(outcome.is_err())));
    let none = promise_resolved(None::<RestrictedPromiseValue>);
    assert!(matches!(promise_poll(&none), Some(Ok(None))));
    let array = array_new(vec![value]);
    let contained = promise_resolved(array.clone());
    assert!(matches!(promise_poll(&contained), Some(Ok(value)) if value.ptr_eq(&array)));
    assert_eq!(checks.get(), 1);
    run_event_loop();
    drop((some, none, array, contained));
    finish();
    assert_eq!(live_heap_objects(), 0);
}
