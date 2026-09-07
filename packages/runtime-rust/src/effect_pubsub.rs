/// Each subscriber holds a suffix of the hub's accepted messages. The
/// longest unread suffix determines shared capacity. Publications commit to
/// every subscriber before waking user code; bounded surplus waits at the hub.
pub struct PubSubState {
    // The scope owns each subscription, which keeps the hub alive. Weak
    // registration avoids an Rc cycle between the hub and its subscriptions.
    subscribers: Vec<std::rc::Weak<RefCell<QueueState>>>,
    capacity: f64,
    strategy: u8,
    shutdown: bool,
    publishers: VecDeque<(EffectValue, Rc<RefCell<Latch>>)>,
    draining: bool,
}

fn pubsub_of(handle: &JsEffect) -> Rc<RefCell<PubSubState>> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::PubSub(state)) => state.clone(),
        _ => throw_error("scriptc: a PubSub handle was expected".to_owned()),
    })
}

pub fn effect_pubsub_make(capacity: f64, strategy: f64) -> JsEffect {
    let strategy = strategy as u8;
    effect_sync(Rc::new(move || effect_box(effect_new(EffectNode::Data(KernelData::PubSub(Rc::new(RefCell::new(
        PubSubState { subscribers: Vec::new(), capacity, strategy, shutdown: false,
            publishers: VecDeque::new(), draining: false },
    ))))))), Box::new(|_| {}))
}

fn pubsub_full(state: &PubSubState) -> bool {
    state.subscribers.iter().filter_map(std::rc::Weak::upgrade).any(|queue| {
        let queue = queue.borrow();
        !queue.shutdown && (queue.items.len() as f64) >= state.capacity
    })
}

/// Call only after shared admission (or sliding eviction). Every queue is
/// changed before any taker resumes, including reentrant publishers.
fn pubsub_broadcast(state: &PubSubState, value: &EffectValue) -> Vec<(QueueWaiter, Outcome)> {
    let mut wake = Vec::new();
    for queue in state.subscribers.iter().filter_map(std::rc::Weak::upgrade) {
        let mut queue = queue.borrow_mut();
        if queue.shutdown { continue; }
        if let Some(taker) = queue.takers.pop_front() {
            wake.push((taker, Ok(value.clone())));
        } else {
            queue.items.push_back(value.clone());
        }
    }
    wake
}

/// Freed space belongs to the oldest pending publication. Publish all state
/// changes before callbacks, and keep a single drainer across callback reentry.
fn pubsub_drain(hub: &Rc<RefCell<PubSubState>>) {
    {
        let mut state = hub.borrow_mut();
        if state.draining { return; }
        state.draining = true;
    }
    loop {
        let ready = {
            let mut state = hub.borrow_mut();
            if pubsub_full(&state) { None }
            else { state.publishers.pop_front().map(|(value, latch)| (latch, pubsub_broadcast(&state, &value))) }
        };
        let Some((latch, wake)) = ready else { break; };
        Latch::settle(&latch, Ok(effect_box(true)));
        queue_wake(wake);
    }
    hub.borrow_mut().draining = false;
}

/// A full bounded hub suspends the publishing fiber. Dropping rejects the
/// publication for ALL subscribers; sliding evicts only the globally oldest
/// message, which is still held by subscribers whose queues are full.
pub fn effect_pubsub_publish(handle: &JsEffect, value: EffectValue) -> JsEffect {
    let hub = pubsub_of(handle);
    effect_suspend(Rc::new(move || {
        let mut state = hub.borrow_mut();
        if state.shutdown {
            return effect_succeed(effect_box(false));
        }
        let full = pubsub_full(&state);
        if state.strategy == 0 && (full || !state.publishers.is_empty()) {
            let latch = Latch::new(0.0);
            state.publishers.push_back((value.clone(), latch.clone()));
            drop(state);
            pubsub_drain(&hub);
            return effect_new(EffectNode::Park(latch, 1.0));
        }
        if full && state.strategy == 1 { return effect_succeed(effect_box(false)); }
        if full {
            for queue in state.subscribers.iter().filter_map(std::rc::Weak::upgrade) {
                let mut queue = queue.borrow_mut();
                if (queue.items.len() as f64) >= state.capacity { queue.items.pop_front(); }
            }
        }
        let wake = pubsub_broadcast(&state, &value);
        drop(state);
        queue_wake(wake);
        effect_succeed(effect_box(true))
    }), no_trace())
}

/// `PubSub.subscribe(hub)`: acquire a fresh queue in the current scope.
pub fn effect_pubsub_subscribe(handle: &JsEffect) -> JsEffect {
    let hub = pubsub_of(handle);
    let release_hub = Rc::downgrade(&hub);
    let acquire = effect_sync(Rc::new(move || {
        let (capacity, strategy) = { let state = hub.borrow(); (state.capacity, state.strategy) };
        let queue = queue_new(capacity, strategy);
        queue_of(&queue).borrow_mut().pubsub = Some(hub.clone());
        let mut state = hub.borrow_mut();
        if state.shutdown { queue_close(&queue_of(&queue)); }
        else { state.subscribers.push(Rc::downgrade(&queue_of(&queue))); }
        effect_box(queue)
    }), no_trace());
    effect_acquire_release(&acquire, Rc::new(move |resource, _exit| {
        let queue = queue_of(&effect_unbox::<JsEffect>(&resource));
        let hub = release_hub.clone();
        effect_sync(Rc::new(move || {
            let hub = hub.upgrade();
            if let Some(hub) = &hub {
                hub.borrow_mut().subscribers.retain(|other| !other.ptr_eq(&Rc::downgrade(&queue)));
            }
            queue_wake(queue_close(&queue));
            if let Some(hub) = hub { pubsub_drain(&hub); }
            effect_box(())
        }), no_trace())
    }), no_trace())
}

pub fn effect_pubsub_shutdown(handle: &JsEffect) -> JsEffect {
    let hub = pubsub_of(handle);
    effect_sync(Rc::new(move || {
        let queues = {
            let mut state = hub.borrow_mut();
            state.shutdown = true;
            std::mem::take(&mut state.subscribers)
        };
        let wake = queues.iter().filter_map(std::rc::Weak::upgrade).flat_map(|queue| queue_close(&queue)).collect();
        queue_wake(wake);
        // Effect 4 closes subscriptions before shutting down its strategy.
        // Their release frees all capacity, so already queued publishers
        // complete successfully; new publications observe shutdown above.
        pubsub_drain(&hub);
        effect_box(())
    }), no_trace())
}
