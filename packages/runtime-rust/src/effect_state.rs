/* The kernel's stateful primitives: `Ref`/`SynchronizedRef` (one mutable cell), `Deferred` (a latch settled once,
 * awaited by any number of fibers) and `Semaphore` (permits over the same waiter queue). The waiting half is the
 * `Latch` of effect.rs, which the fiber driver parks on exactly as it suspends on a promise. */

/// The cell behind a `Ref`/`SynchronizedRef` handle.
fn ref_cell_of(handle: &JsEffect) -> Rc<RefCell<EffectValue>> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Ref(cell)) => cell.clone(),
        _ => throw_error("scriptc: a Ref handle was expected".to_owned()),
    })
}

/// `Ref.makeUnsafe(a)` / `SynchronizedRef.makeUnsafe(a)`: the cell itself, outside any effect.
pub fn effect_ref_make_unsafe(value: EffectValue) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Ref(Rc::new(RefCell::new(value)))))
}

/// `Ref.make(a)`: an effect answering a FRESH cell each time it runs.
pub fn effect_ref_make(value: EffectValue) -> JsEffect {
    effect_sync(Rc::new(move || effect_box(effect_ref_make_unsafe(value.clone()))), Box::new(|_| {}))
}

pub fn effect_ref_get(handle: &JsEffect) -> JsEffect {
    let cell = ref_cell_of(handle);
    effect_sync(Rc::new(move || cell.borrow().clone()), Box::new(|_| {}))
}

/// `Ref.set(ref, a)` and, with `keep`, `Ref.getAndSet(ref, a)`: which value the effect answers (0 unit, 1 previous).
pub fn effect_ref_set(handle: &JsEffect, value: EffectValue, keep: f64) -> JsEffect {
    let cell = ref_cell_of(handle);
    effect_sync(Rc::new(move || {
        let previous = cell.borrow().clone();
        *cell.borrow_mut() = value.clone();
        if keep as i32 == 1 { previous } else { effect_box(()) }
    }), Box::new(|_| {}))
}

/// `Ref.update(ref, f)` — and, with `keep`, `getAndSet`/`updateAndGet`: which of the two values the effect answers.
pub fn effect_ref_update(handle: &JsEffect, f: Rc<dyn Fn(EffectValue) -> EffectValue>, keep: f64, trace: Box<dyn Fn(&mut Tracer<'_>)>) -> JsEffect {
    let cell = ref_cell_of(handle);
    effect_sync(Rc::new(move || {
        let previous = cell.borrow().clone();
        let next = f(previous.clone());
        *cell.borrow_mut() = next.clone();
        match keep as i32 { 1 => previous, 2 => next, _ => effect_box(()) }
    }), trace)
}

/// `SynchronizedRef.updateEffect(ref, f)`: the update runs as an effect, sequentially (one fiber at a time is the
/// runtime's own discipline), and the ref holds its success.
pub fn effect_ref_update_effect(handle: &JsEffect, f: Rc<dyn Fn(EffectValue) -> JsEffect>, trace: Box<dyn Fn(&mut Tracer<'_>)>) -> JsEffect {
    let cell = ref_cell_of(handle);
    let read = effect_ref_get(handle);
    effect_flat_map(&read, Rc::new(move |previous| {
        let cell = cell.clone();
        effect_map(&f(previous), Rc::new(move |next| { *cell.borrow_mut() = next.clone(); effect_box(()) }), Box::new(|_| {}))
    }), trace)
}

fn latch_of(handle: &JsEffect, what: &str) -> Rc<RefCell<Latch>> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Deferred(latch)) | EffectNode::Data(KernelData::Semaphore(latch)) => latch.clone(),
        _ => throw_error(format!("scriptc: a {what} handle was expected")),
    })
}

/// `Deferred.make()`: an effect answering a FRESH latch each run.
pub fn effect_deferred_make() -> JsEffect {
    effect_sync(Rc::new(|| effect_box(effect_new(EffectNode::Data(KernelData::Deferred(Latch::new(0.0)))))), Box::new(|_| {}))
}

/// `Deferred.await(d)`: park until the latch settles (a failure resumes as this fiber's failure).
pub fn effect_deferred_await(handle: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Park(latch_of(handle, "Deferred")))
}

/// `Deferred.succeed(d, a)` / `Deferred.fail(d, e)`: settle once — the effect answers whether THIS call did it.
pub fn effect_deferred_settle(handle: &JsEffect, value: EffectValue, ok: bool) -> JsEffect {
    let latch = latch_of(handle, "Deferred");
    effect_sync(Rc::new(move || {
        let outcome = if ok { Ok(value.clone()) } else { Err(value.clone()) };
        effect_box(latch.borrow_mut().settle(outcome))
    }), Box::new(|_| {}))
}

pub fn effect_deferred_is_done(handle: &JsEffect) -> JsEffect {
    let latch = latch_of(handle, "Deferred");
    effect_sync(Rc::new(move || effect_box(latch.borrow().settled.is_some())), Box::new(|_| {}))
}

/// `Semaphore.makeUnsafe(permits)`: the permit count with the same waiter queue.
pub fn effect_semaphore_make_unsafe(permits: f64) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Semaphore(Latch::new(permits))))
}

pub fn effect_semaphore_make(permits: f64) -> JsEffect {
    effect_sync(Rc::new(move || effect_box(effect_semaphore_make_unsafe(permits))), Box::new(|_| {}))
}

/// `semaphore.withPermits(n)(effect)`: take n permits, run, release them however the effect ends.
pub fn effect_semaphore_with_permits(handle: &JsEffect, permits: f64, body: &JsEffect) -> JsEffect {
    let latch = latch_of(handle, "Semaphore");
    let take = effect_semaphore_take(&latch, permits);
    let release = effect_semaphore_release(&latch, permits);
    effect_zip_right(&take, &effect_ensuring(body, &release))
}

fn effect_semaphore_take(latch: &Rc<RefCell<Latch>>, permits: f64) -> JsEffect {
    // One permit per park: n permits are n parks, which is exactly effect's own fairness for a sequential runtime.
    let mut taken = effect_new(EffectNode::Park(latch.clone()));
    let mut remaining = permits - 1.0;
    while remaining >= 1.0 {
        taken = effect_zip_right(&taken, &effect_new(EffectNode::Park(latch.clone())));
        remaining -= 1.0;
    }
    taken
}

fn effect_semaphore_release(latch: &Rc<RefCell<Latch>>, permits: f64) -> JsEffect {
    let latch = latch.clone();
    effect_sync(Rc::new(move || {
        let mut state = latch.borrow_mut();
        let mut freed = permits;
        while freed >= 1.0 {
            match state.waiters.pop() {
                // A queued fiber takes the permit straight from the release (no count round-trip).
                Some(waiter) => { drop(state); waiter(Ok(Rc::new(()) as EffectValue)); state = latch.borrow_mut(); }
                None => state.permits += 1.0,
            }
            freed -= 1.0;
        }
        effect_box(())
    }), Box::new(|_| {}))
}

/// A `Queue`: items with the fibers waiting to take them and the fibers waiting for room to offer. `capacity` is
/// infinite for an unbounded queue; `strategy` says what a full BOUNDED queue does with a new item — 0 parks the
/// offering fiber, 1 drops the item (`Queue.dropping`), 2 evicts the oldest (`Queue.sliding`).
/// A fiber waiting on a queue: the callback that resumes it with the operation's outcome.
type QueueWaiter = Box<dyn FnOnce(Outcome)>;

pub struct QueueState {
    items: std::collections::VecDeque<EffectValue>,
    capacity: f64,
    strategy: u8,
    takers: std::collections::VecDeque<QueueWaiter>,
    offerers: std::collections::VecDeque<(EffectValue, QueueWaiter)>,
    shutdown: bool,
}

fn queue_new(capacity: f64, strategy: u8) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Queue(Rc::new(RefCell::new(QueueState {
        items: std::collections::VecDeque::new(), capacity, strategy,
        takers: std::collections::VecDeque::new(), offerers: std::collections::VecDeque::new(), shutdown: false,
    })))))
}

fn queue_of(handle: &JsEffect) -> Rc<RefCell<QueueState>> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Queue(queue)) => queue.clone(),
        _ => throw_error("scriptc: a Queue handle was expected".to_owned()),
    })
}

/// One queue operation for the fiber driver: the outcome when it completes at once, or None when `waiter` was
/// queued (the fiber that completes the other half drives this one).
fn queue_step(queue: &Rc<RefCell<QueueState>>, value: Option<EffectValue>, waiter: QueueWaiter) -> Option<Outcome> {
    let mut state = queue.borrow_mut();
    match value {
        // TAKE: an item, else the oldest parked offer (which frees its fiber), else park.
        None => {
            if let Some(item) = state.items.pop_front() {
                if let Some((offered, offerer)) = state.offerers.pop_front() {
                    state.items.push_back(offered);
                    drop(state);
                    offerer(Ok(effect_box(true)));
                } 
                return Some(Ok(item));
            }
            if let Some((offered, offerer)) = state.offerers.pop_front() {
                drop(state);
                offerer(Ok(effect_box(true)));
                return Some(Ok(offered));
            }
            if state.shutdown {
                return Some(Err(effect_box("Queue is shut down".to_owned())));
            }
            state.takers.push_back(waiter);
            None
        }
        // OFFER: hand it to a waiting taker, else store it, else follow the full-queue strategy.
        Some(item) => {
            if state.shutdown {
                return Some(Ok(effect_box(false)));
            }
            if let Some(taker) = state.takers.pop_front() {
                drop(state);
                taker(Ok(item));
                return Some(Ok(effect_box(true)));
            }
            if (state.items.len() as f64) < state.capacity {
                state.items.push_back(item);
                return Some(Ok(effect_box(true)));
            }
            match state.strategy {
                1 => Some(Ok(effect_box(false))),
                2 => { state.items.pop_front(); state.items.push_back(item); Some(Ok(effect_box(true))) }
                _ => { state.offerers.push_back((item, waiter)); None }
            }
        }
    }
}

/// `Queue.unbounded()` / `bounded(n)` / `dropping(n)` / `sliding(n)`: an effect answering a FRESH queue.
pub fn effect_queue_make(capacity: f64, strategy: f64) -> JsEffect {
    let strategy = strategy as u8;
    effect_sync(Rc::new(move || effect_box(queue_new(capacity, strategy))), Box::new(|_| {}))
}

pub fn effect_queue_take(handle: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Queue(queue_of(handle), None))
}

pub fn effect_queue_offer(handle: &JsEffect, value: EffectValue) -> JsEffect {
    effect_new(EffectNode::Queue(queue_of(handle), Some(value)))
}

pub fn effect_queue_size(handle: &JsEffect) -> JsEffect {
    let queue = queue_of(handle);
    effect_sync(Rc::new(move || effect_box(queue.borrow().items.len() as f64)), Box::new(|_| {}))
}

/// `Queue.shutdown`: later offers answer false, and a take on an empty shut-down queue FAILS with "Queue is shut
/// down" (effect interrupts the taking fiber there; the kernel has no interruption yet — a failure is the closest
/// observable, and it keeps the runtime going).
pub fn effect_queue_shutdown(handle: &JsEffect) -> JsEffect {
    let queue = queue_of(handle);
    effect_sync(Rc::new(move || {
        let mut state = queue.borrow_mut();
        state.shutdown = true;
        let takers = std::mem::take(&mut state.takers);
        drop(state);
        for taker in takers {
            taker(Err(effect_box("Queue is shut down".to_owned())));
        }
        effect_box(())
    }), Box::new(|_| {}))
}

/// A `PubSub`: every subscriber gets its own queue, and a publish copies the value into each of them (the
/// broadcast semantics effect gives). A subscription is a Dequeue handle — the same Queue the kernel already
/// runs — so takes, sizes and shutdowns work on it unchanged. Divergence: a subscription lives as long as the
/// PubSub (effect unsubscribes when the subscribing scope closes; the kernel has no scope hook for it yet).
pub struct PubSubState {
    subscribers: Vec<Rc<RefCell<QueueState>>>,
    capacity: f64,
    strategy: u8,
    shutdown: bool,
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
        PubSubState { subscribers: Vec::new(), capacity, strategy, shutdown: false },
    ))))))), Box::new(|_| {}))
}

/// `PubSub.publish(hub, a)`: the value reaches every subscriber's queue (a full one follows its own strategy).
pub fn effect_pubsub_publish(handle: &JsEffect, value: EffectValue) -> JsEffect {
    let hub = pubsub_of(handle);
    effect_sync(Rc::new(move || {
        let state = hub.borrow();
        if state.shutdown {
            return effect_box(false);
        }
        let queues: Vec<Rc<RefCell<QueueState>>> = state.subscribers.clone();
        drop(state);
        for queue in queues {
            queue_step(&queue, Some(value.clone()), Box::new(|_| {}));
        }
        effect_box(true)
    }), Box::new(|_| {}))
}

/// `PubSub.subscribe(hub)`: a fresh queue registered with the hub, answered as a Dequeue handle.
pub fn effect_pubsub_subscribe(handle: &JsEffect) -> JsEffect {
    let hub = pubsub_of(handle);
    effect_sync(Rc::new(move || {
        let (capacity, strategy) = { let state = hub.borrow(); (state.capacity, state.strategy) };
        let queue = queue_new(capacity, strategy);
        hub.borrow_mut().subscribers.push(queue_of(&queue));
        effect_box(queue)
    }), Box::new(|_| {}))
}

pub fn effect_pubsub_shutdown(handle: &JsEffect) -> JsEffect {
    let hub = pubsub_of(handle);
    effect_sync(Rc::new(move || { hub.borrow_mut().shutdown = true; effect_box(()) }), Box::new(|_| {}))
}

/// `Effect.tryPromise(() => promise)` — the single-thunk form: a rejection becomes effect's `UnknownError`, a
/// kernel data handle with effect's own tag and message.
pub fn effect_try_promise_unknown(thunk: Rc<dyn Fn() -> JsPromiseHandle>, trace: Box<dyn Fn(&mut Tracer<'_>)>) -> JsEffect {
    effect_try_promise(thunk, Rc::new(|reason| {
        let _ = &reason; // effect keeps the reason in the error's `cause`, which the kernel does not model yet
        effect_box(effect_new(EffectNode::Data(KernelData::Unknown(string("An error occurred in Effect.tryPromise")))))
    }), trace)
}

/// A `Cause`: why an effect ended. `die` marks a defect cause; the value is the error (or the defect).
pub fn effect_cause_new(die: bool, value: EffectValue) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Cause(die, value)))
}

fn cause_of(handle: &JsEffect) -> (bool, EffectValue) {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Cause(die, value)) => (*die, value.clone()),
        _ => throw_error("scriptc: a Cause handle was expected".to_owned()),
    })
}

/// `Cause.squash(cause)`: the error a failure carries, or the defect a die carries.
pub fn effect_cause_squash(handle: &JsEffect) -> EffectValue {
    cause_of(handle).1
}

/// `Cause.hasDies` / `hasInterrupts` / `hasInterruptsOnly`: the kernel has no interruption, so only dies answer.
pub fn effect_cause_has(handle: &JsEffect, what: f64) -> bool {
    let (die, _) = cause_of(handle);
    match what as i32 {
        0 => die,
        _ => false,
    }
}

pub fn effect_catch_cause(source: &JsEffect, f: Rc<dyn Fn(EffectValue) -> JsEffect>, trace: Box<dyn Fn(&mut Tracer<'_>)>) -> JsEffect {
    effect_new(EffectNode::CatchCause(source.clone(), f, trace))
}
