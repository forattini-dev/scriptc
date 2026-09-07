/// Failures, defects and interruption unwind the Effect continuation stack.
/// Ordinary failure handlers only recover Fail; catchCause observes all three.
#[derive(Clone)]
pub enum EffectFailure {
    Fail(EffectValue),
    Die(EffectValue),
    Interrupt,
    /// Ordered finalizer reasons; nested groups are flattened on combination.
    Combined(Vec<EffectFailure>),
}

impl EffectFailure {
    fn into_value(self) -> EffectValue {
        self.first_value(true).or_else(|| self.first_value(false))
            .unwrap_or_else(|| effect_box(error_new("Error", string("All fibers interrupted without error"))))
    }

    fn first_value(&self, typed: bool) -> Option<EffectValue> {
        match self {
            Self::Fail(value) if typed => Some(value.clone()),
            Self::Die(value) if !typed => Some(value.clone()),
            Self::Combined(reasons) => reasons.iter().find_map(|reason| reason.first_value(typed)),
            _ => None,
        }
    }

    fn combine(self, next: Self) -> Self {
        let mut reasons = match self { Self::Combined(reasons) => reasons, reason => vec![reason] };
        match next { Self::Combined(next) => reasons.extend(next), reason => reasons.push(reason) }
        Self::Combined(reasons)
    }

    fn has(&self, what: u8) -> bool {
        match self {
            Self::Combined(reasons) if what == 2 => !reasons.is_empty() && reasons.iter().all(|reason| reason.has(what)),
            Self::Combined(reasons) => reasons.iter().any(|reason| reason.has(what)),
            Self::Die(_) => what == 0,
            Self::Interrupt => what == 1 || what == 2,
            Self::Fail(_) => false,
        }
    }

    /// Effect.mapError/orDie replace the whole cause using its first typed
    /// failure. A cause without a typed failure passes through intact.
    fn map_typed(self, f: impl FnOnce(EffectValue) -> Self) -> Self {
        match self.first_value(true) { Some(value) => f(value), None => self }
    }

    fn into_cause(self) -> JsEffect {
        effect_new(EffectNode::Data(KernelData::Cause(self)))
    }

    fn into_effect(self) -> JsEffect {
        match self {
            Self::Fail(value) => effect_fail(value),
            Self::Die(value) => effect_die(value),
            Self::Interrupt => effect_new(EffectNode::Interrupt),
            combined @ Self::Combined(_) => effect_new(EffectNode::FailCause(combined)),
        }
    }
}

fn scriptc_defect(payload: Box<dyn Any + Send>) -> EffectFailure {
    if !is_scriptc_unwind(payload.as_ref()) {
        std::panic::resume_unwind(payload);
    }
    EffectFailure::Die(caught_from_panic(payload).value)
}

fn catch_effect_defect(operation: impl FnOnce() -> Outcome) -> Outcome {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)) {
        Ok(outcome) => outcome,
        Err(payload) => Err(scriptc_defect(payload)),
    }
}

/// A throw from a user callback becomes a defect at the same continuation
/// position, so finalizers and synchronized-ref permits still unwind. Rust
/// implementation panics retain their original fatal behavior.
fn fiber_drive(fiber: &FiberRef) {
    while let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fiber_drive_inner(fiber))) {
        let failure = scriptc_defect(payload);
        let mut state = fiber.borrow_mut();
        state.current = None;
        state.resumed = Some(Err(failure));
    }
}
