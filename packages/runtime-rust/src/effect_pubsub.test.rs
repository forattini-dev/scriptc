/// Keep a real subscription's acquiring scope open until its Deferred settles.
fn held_pubsub_subscription(hub: &JsEffect) -> (JsEffect, JsEffect, JsPromise<()>) {
    let stop = effect_unbox::<JsEffect>(&effect_run_sync(&effect_deferred_make()));
    let waiting = stop.clone();
    let slot = Rc::new(RefCell::new(None));
    let captured = slot.clone();
    let body = effect_flat_map(&effect_pubsub_subscribe(hub), Rc::new(move |value| {
        *captured.borrow_mut() = Some(effect_unbox::<JsEffect>(&value));
        effect_deferred_await(&waiting)
    }), super::no_trace());
    let owner = effect_run_promise(&effect_scoped(&body), Rc::new(|_| ()));
    let subscription = slot.borrow_mut().take().expect("synchronous acquisition");
    (subscription, stop, owner)
}

fn close_held_subscription(stop: &JsEffect) {
    effect_run_sync(&effect_deferred_settle(stop, effect_box(()), true));
}

#[test]
fn open_subscription_retains_hub_until_scope_release_without_a_cycle() {
    let hub = effect_unbox::<JsEffect>(&effect_run_sync(&effect_pubsub_make(1.0, 0.0)));
    let state = pubsub_of(&hub);
    let weak = Rc::downgrade(&state);
    let (subscription, stop, owner) = held_pubsub_subscription(&hub);
    drop((hub, state));
    assert!(weak.upgrade().is_some(), "a live subscription still needs shared admission state");
    close_held_subscription(&stop);
    assert!(weak.upgrade().is_none(), "a closed handle must not retain the hub or form a cycle");
    drop((subscription, owner));
}

#[test]
fn pending_pubsub_payloads_release_on_unsubscribe_and_shutdown() {
    for shutdown in [false, true] {
        let hub = effect_unbox::<JsEffect>(&effect_run_sync(&effect_pubsub_make(1.0, 0.0)));
        let (subscription, stop, owner) = held_pubsub_subscription(&hub);
        effect_run_sync(&effect_pubsub_publish(&hub, effect_box(1.0)));
        let payload = effect_box(vec![7u8; 4096]);
        let weak = Rc::downgrade(&payload);
        let completed = Rc::new(Cell::new(false));
        let flag = completed.clone();
        let publish = effect_map(&effect_pubsub_publish(&hub, payload.clone()), Rc::new(move |value| {
            assert!(effect_unbox::<bool>(&value));
            flag.set(true);
            value
        }), super::no_trace());
        let pending = effect_run_promise(&publish, Rc::new(effect_unbox::<bool>));
        drop((payload, publish));
        assert!(!completed.get(), "full hub must suspend its producer");
        assert!(weak.upgrade().is_some());
        assert_eq!(pubsub_of(&hub).borrow().publishers.len(), 1);
        assert!(queue_of(&subscription).borrow().offerers.is_empty(), "surplus belongs to the hub");
        if shutdown { effect_run_sync(&effect_pubsub_shutdown(&hub)); }
        else { close_held_subscription(&stop); }
        assert!(completed.get(), "Effect 4 admits queued publications as subscriptions close");
        assert!(weak.upgrade().is_none(), "completed surplus must release its payload");
        assert!(pubsub_of(&hub).borrow().publishers.is_empty());
        if shutdown { close_held_subscription(&stop); }
        drop((subscription, owner, pending));
    }
}

#[test]
fn pubsub_broadcast_commits_all_subscribers_before_reentrant_publication() {
    let hub = effect_unbox::<JsEffect>(&effect_run_sync(&effect_pubsub_make(1.0, 0.0)));
    let (first, stop_first, owner_first) = held_pubsub_subscription(&hub);
    let (second, stop_second, owner_second) = held_pubsub_subscription(&hub);
    let reentrant = hub.clone();
    let read = effect_flat_map(&effect_queue_take(&first), Rc::new(move |value| {
        assert_eq!(effect_unbox::<f64>(&value), 1.0);
        effect_pubsub_publish(&reentrant, effect_box(2.0))
    }), super::no_trace());
    let pending = effect_run_promise(&read, Rc::new(effect_unbox::<bool>));
    effect_run_sync(&effect_pubsub_publish(&hub, effect_box(1.0)));
    assert_eq!(pubsub_of(&hub).borrow().publishers.len(), 1,
        "the slow subscriber must already hold 1 when the fast subscriber publishes 2");
    assert!(queue_of(&first).borrow().items.is_empty());
    assert_eq!(effect_unbox::<f64>(&effect_run_sync(&effect_queue_take(&second))), 1.0);
    for subscription in [&first, &second] {
        assert_eq!(effect_unbox::<f64>(&effect_run_sync(&effect_queue_take(subscription))), 2.0);
    }
    close_held_subscription(&stop_first);
    close_held_subscription(&stop_second);
    drop((owner_first, owner_second, pending));
}

#[test]
fn pubsub_drainer_keeps_fifo_when_a_resumed_publisher_publishes_again() {
    let hub = effect_unbox::<JsEffect>(&effect_run_sync(&effect_pubsub_make(1.0, 0.0)));
    let (subscription, stop, owner) = held_pubsub_subscription(&hub);
    effect_run_sync(&effect_pubsub_publish(&hub, effect_box(1.0)));
    let reentrant = hub.clone();
    let chained = effect_flat_map(&effect_pubsub_publish(&hub, effect_box(2.0)), Rc::new(move |_| {
        effect_pubsub_publish(&reentrant, effect_box(4.0))
    }), super::no_trace());
    let second = effect_run_promise(&chained, Rc::new(effect_unbox::<bool>));
    let third = effect_run_promise(&effect_pubsub_publish(&hub, effect_box(3.0)), Rc::new(effect_unbox::<bool>));
    for expected in [1.0, 2.0, 3.0, 4.0] {
        assert_eq!(effect_unbox::<f64>(&effect_run_sync(&effect_queue_take(&subscription))), expected);
    }
    assert!(pubsub_of(&hub).borrow().publishers.is_empty());
    assert!(!pubsub_of(&hub).borrow().draining);
    close_held_subscription(&stop);
    drop((owner, second, third));
}
