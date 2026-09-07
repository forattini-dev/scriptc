#[test]
fn pubsub_scope_releases_subscriptions_and_buffered_values() {
    let hub = effect_unbox::<JsEffect>(&effect_run_sync(&effect_pubsub_make(8.0, 0.0)));
    let state = pubsub_of(&hub);
    for _ in 0..100 {
        let payload = effect_box(vec![0u8; 4096]);
        let weak = Rc::downgrade(&payload);
        let acquire = effect_pubsub_subscribe(&hub);
        let published = effect_pubsub_publish(&hub, payload.clone());
        let program = effect_scoped(&effect_zip_right(&acquire, &published));
        effect_run_sync(&program);
        drop((payload, acquire, published, program));
        assert!(state.borrow().subscribers.is_empty(), "closed scopes must unregister subscriptions");
        assert!(weak.upgrade().is_none(), "closed subscriptions must release queued payloads");
    }
}

#[test]
fn pubsub_scope_releases_on_failure_and_defect() {
    let hub = effect_unbox::<JsEffect>(&effect_run_sync(&effect_pubsub_make(8.0, 0.0)));
    for failure in [effect_fail(effect_box(1.0)), effect_die(effect_box(2.0))] {
        let program = effect_exit(&effect_scoped(&effect_zip_right(&effect_pubsub_subscribe(&hub), &failure)));
        let exit = effect_unbox::<JsEffect>(&effect_run_sync(&program));
        assert!(!effect_exit_is_success(&exit));
        assert!(pubsub_of(&hub).borrow().subscribers.is_empty());
    }
}

#[test]
fn queue_shutdown_releases_buffered_and_pending_payloads() {
    let queue = queue_new(1.0, 0);
    let state = queue_of(&queue);
    let payload = effect_box(vec![0u8; 4096]);
    let weak = Rc::downgrade(&payload);
    queue_step(&state, Some(payload.clone()), Box::new(|_| panic!("immediate offer")));
    let resumed = Rc::new(Cell::new(false));
    let observed = resumed.clone();
    let reread = state.clone();
    queue_step(&state, Some(payload.clone()), Box::new(move |outcome| {
        assert!(!effect_unbox::<bool>(&outcome.unwrap_or_else(|_| panic!("offers must answer false"))));
        assert!(reread.borrow().shutdown, "publish shutdown before resuming the offerer");
        assert!(reread.borrow().items.is_empty());
        observed.set(true);
    }));
    drop(payload);
    effect_run_sync(&effect_queue_shutdown(&queue));
    assert!(resumed.get(), "shutdown must wake blocked publishers");
    assert!(weak.upgrade().is_none(), "shutdown must release queued and pending values");
}
