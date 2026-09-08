#[test]
fn sync_exit_keeps_pending_work_alive_and_releases_it_after_completion() {
    let gate = effect_unbox::<JsEffect>(&effect_run_sync(&effect_deferred_make()));
    let cleanups = Rc::new(Cell::new(0));
    let payload = effect_box(vec![7u8; 4096]);
    let weak = Rc::downgrade(&payload);
    let count = cleanups.clone();
    let cleanup = effect_sync(Rc::new(move || {
        assert_eq!(effect_unbox::<Vec<u8>>(&payload).len(), 4096);
        count.set(count.get() + 1);
        effect_box(())
    }), super::no_trace());
    let work = effect_ensuring(&effect_deferred_await(&gate), &cleanup);
    let snapshot = effect_run_sync_exit(&work);
    let Err(EffectFailure::Die(value)) = exit_of(&snapshot) else {
        panic!("pending work must be a defect, not an interruption");
    };
    let error = effect_unbox::<JsError>(&value);
    assert_eq!(error_name(&error), string("AsyncFiberError"));
    assert_eq!(error_message(&error), string("An asynchronous Effect was executed with Effect.runSync"));
    drop((work, cleanup));
    assert_eq!(cleanups.get(), 0);
    assert!(weak.upgrade().is_some(), "suspended fiber must retain cleanup");
    let settle = effect_deferred_settle(&gate, effect_box(7.0), true);
    assert!(effect_unbox::<bool>(&effect_run_sync(&settle)));
    assert_eq!(cleanups.get(), 1);
    assert!(!effect_unbox::<bool>(&effect_run_sync(&settle)));
    assert_eq!(cleanups.get(), 1);
    assert!(weak.upgrade().is_none(), "completed fiber must release cleanup");
    assert!(matches!(exit_of(&snapshot), Err(EffectFailure::Die(_))), "completion must not mutate the earlier snapshot");
}

#[test]
fn sync_exit_preserves_success_typed_failure_and_defect() {
    let value = effect_box(42.0);
    let success = effect_run_sync_exit(&effect_succeed(value.clone()));
    assert_eq!(effect_unbox::<f64>(&exit_of(&success).ok().expect("success")), 42.0);
    let failed = effect_run_sync_exit(&effect_fail(value.clone()));
    assert!(matches!(exit_of(&failed), Err(EffectFailure::Fail(_))));
    let died = effect_run_sync_exit(&effect_die(value));
    assert!(matches!(exit_of(&died), Err(EffectFailure::Die(_))));
}

#[test]
fn nonpositive_and_nan_sleeps_complete_synchronously() {
    for duration in [0.0, -0.0, -1.0, f64::NEG_INFINITY, f64::NAN] {
        assert!(effect_exit_is_success(&effect_run_sync_exit(&effect_sleep(duration))));
    }
    assert!(effect_exit_is_success(&effect_run_sync_exit(&effect_sleep_text(&string("0 millis")))));
}
