/// Failures, defects and interruption unwind the Effect continuation stack.
/// Ordinary failure handlers only recover Fail; catchCause observes all three.
#[derive(Clone)]
pub enum EffectFailure {
    Fail(EffectValue),
    Die(EffectValue),
    Interrupt,
}

impl EffectFailure {
    fn into_value(self) -> EffectValue {
        match self {
            Self::Fail(value) | Self::Die(value) => value,
            Self::Interrupt => effect_box(error_new("Error", string("All fibers interrupted without error"))),
        }
    }

    fn into_cause(self) -> JsEffect {
        effect_new(EffectNode::Data(KernelData::Cause(self)))
    }

    fn into_effect(self) -> JsEffect {
        match self {
            Self::Fail(value) => effect_fail(value),
            Self::Die(value) => effect_die(value),
            Self::Interrupt => effect_new(EffectNode::Interrupt),
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
