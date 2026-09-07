type LatchWaiter = (f64, Box<dyn FnOnce(Outcome)>);

/// Deferred settlement and weighted semaphore requests share suspension,
/// but a semaphore request reserves its entire weight atomically.
pub struct Latch {
    settled: Option<Outcome>,
    permits: f64,
    taken: f64,
    waiters: VecDeque<LatchWaiter>,
}

impl Latch {
    fn new(permits: f64) -> Rc<RefCell<Self>> {
        Rc::new(RefCell::new(Self { settled: None, permits, taken: 0.0, waiters: VecDeque::new() }))
    }

    fn free(&self) -> f64 { self.permits - self.taken }

    fn settle(latch: &Rc<RefCell<Self>>, outcome: Outcome) -> bool {
        let waiters = {
            let mut state = latch.borrow_mut();
            if state.settled.is_some() { return false; }
            state.settled = Some(outcome.clone());
            std::mem::take(&mut state.waiters)
        };
        // Resumed code may read, await or settle this same Deferred.
        // Publish the outcome and release the borrow before calling it.
        for (_, waiter) in waiters { waiter(outcome.clone()); }
        true
    }
}

fn latch_park(latch: &Rc<RefCell<Latch>>, permits: f64, waiter: Box<dyn FnOnce(Outcome)>) -> Option<Outcome> {
    let mut state = latch.borrow_mut();
    if let Some(outcome) = &state.settled { return Some(outcome.clone()); }
    // Match Effect's `free < n` check, including fractional/zero weights.
    if state.free().partial_cmp(&permits) != Some(std::cmp::Ordering::Less) {
        state.taken += permits;
        return Some(Ok(effect_box(())));
    }
    state.waiters.push_back((permits, waiter));
    None
}

fn effect_semaphore_take(latch: &Rc<RefCell<Latch>>, permits: f64) -> JsEffect {
    effect_new(EffectNode::Park(latch.clone(), permits))
}

fn effect_semaphore_release(latch: &Rc<RefCell<Latch>>, permits: f64) -> JsEffect {
    let latch = latch.clone();
    effect_sync(Rc::new(move || {
        latch.borrow_mut().taken -= permits;
        loop {
            let waiter = {
                let mut state = latch.borrow_mut();
                if state.free().partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) { break; }
                // A larger pending request does not block an eligible smaller
                // one. Preserve arrival order among eligible requests.
                let next = state.waiters.iter().position(|(needed, _)| state.free() >= *needed);
                let Some(index) = next else { break; };
                let (needed, waiter) = state.waiters.remove(index).expect("queued semaphore waiter");
                state.taken += needed;
                waiter
            };
            waiter(Ok(effect_box(())));
        }
        effect_box(())
    }), Box::new(|_| {}))
}
