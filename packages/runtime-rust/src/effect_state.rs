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
