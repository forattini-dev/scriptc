/// Take the synchronous snapshot. Like Effect 4, a pending fiber keeps
/// running: the diagnostic does not cancel its wait or run cleanup early.
fn effect_start_sync(effect: &JsEffect) -> Outcome {
    let exit: Rc<RefCell<Option<Outcome>>> = Rc::new(RefCell::new(None));
    let slot = exit.clone();
    let fiber = fiber_new(effect, Box::new(move |outcome| *slot.borrow_mut() = Some(outcome)));
    fiber_drive(&fiber);
    exit.borrow_mut().take().unwrap_or_else(|| Err(EffectFailure::Die(effect_box(error_new(
        "AsyncFiberError", string("An asynchronous Effect was executed with Effect.runSync"),
    )))))
}

/// A synchronous value, or a throw of the failed snapshot's squashed cause.
pub fn effect_run_sync(effect: &JsEffect) -> EffectValue {
    match effect_start_sync(effect) {
        Ok(value) => value,
        Err(error) => effect_defect(error.into_value()),
    }
}

/// Unlike runSync(exit(effect)), this returns a Failure even when pending.
pub fn effect_run_sync_exit(effect: &JsEffect) -> JsEffect {
    exit_handle(effect_start_sync(effect))
}

/// `Effect.runPromise`: a promise of the site's type, settled by the fiber's exit.
pub fn effect_run_promise<T: HeapValue>(effect: &JsEffect, unbox: Rc<dyn Fn(&EffectValue) -> T>) -> JsPromise<T> {
    let promise = promise_new::<T>();
    let target = promise.clone();
    let fiber = fiber_new(
        effect,
        Box::new(move |outcome| match outcome {
            Ok(value) => {
                let _ = promise_fulfill(&target, unbox(&value));
            }
            Err(error) => {
                let _ = promise_reject(&target, caught_from_any(error.into_value()));
            }
        }),
    );
    fiber_drive(&fiber);
    promise
}
