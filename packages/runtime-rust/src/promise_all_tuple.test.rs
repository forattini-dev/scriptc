#[test]
fn all_tuple_keeps_slot_order_and_schedules_one_reaction_per_entry() {
    init();
    let first = promise_new::<JsString>();
    let second = promise_resolved(7.0);
    let result = promise_all_tuple(vec![promise_to_handle(&first), promise_to_handle(&second)], |values| {
        let mut values = values.into_iter();
        let text = *values.next().unwrap().downcast::<JsString>().unwrap();
        let number = *values.next().unwrap().downcast::<f64>().unwrap();
        assert_eq!(text.as_ref(), "text");
        number
    });
    run_event_loop();
    assert!(promise_poll(&result).is_none());
    promise_fulfill(&first, string("text"));
    assert!(promise_poll(&result).is_none());
    run_event_loop();
    assert!(matches!(promise_poll(&result), Some(Ok(7.0))));
    drop((first, second, result));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn all_tuple_rejects_in_settlement_order_and_releases_partial_values() {
    init();
    let payload = array_new(vec![1.0]);
    let first = promise_resolved(payload.clone());
    let second = promise_new::<f64>();
    let third = promise_new::<bool>();
    let result = promise_all_tuple(vec![promise_to_handle(&first), promise_to_handle(&second), promise_to_handle(&third)], |_| 0.0);
    promise_then(&result, Box::new(|outcome| {
        let reason = outcome.expect_err("must reject");
        assert_eq!(error_message(&caught_narrow::<JsError>(&reason)).as_ref(), "third first");
    }));
    run_event_loop();
    promise_reject(&third, caught_value(error_new("Error", string("third first"))));
    promise_reject(&second, caught_value(error_new("Error", string("second later"))));
    run_event_loop();
    assert!(matches!(promise_poll(&result), Some(Err(_))));
    drop((first, second, third, payload, result));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn all_tuple_assembler_failure_rejects_the_result() {
    init();
    let result = promise_all_tuple(vec![promise_to_handle(&promise_resolved(1.0))], |_| -> f64 {
        throw_value(error_new("Error", string("assembly")))
    });
    promise_then(&result, Box::new(|outcome| {
        assert_eq!(error_message(&caught_narrow::<JsError>(&outcome.unwrap_err())).as_ref(), "assembly");
    }));
    run_event_loop();
    drop(result);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
