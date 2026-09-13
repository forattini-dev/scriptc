// Direct native Effect.succeed/sync producers retain typed values until execution.
// A shared Rc<dyn Any> cannot enumerate its inner owning edges once per Effect
// owner: the Rc may have aliases outside the collector, or several Effects may
// share its single payload edge. Keeping one typed value here gives the collector
// exactly one edge for each actual native owner, without changing the channel ABI.
trait EffectOwnedValue {
    fn trace(&self, tracer: &mut Tracer<'_>);
    fn evaluate(&self) -> EffectValue;
}

struct OwnedEffectValue<T> {
    value: T,
    evaluate: fn(&T) -> EffectValue,
}

impl<T: HeapValue> EffectOwnedValue for OwnedEffectValue<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) { self.value.trace_value(tracer); }
    fn evaluate(&self) -> EffectValue { (self.evaluate)(&self.value) }
}

/// Retains one typed native value, tracing its owning edges without running the
/// eraser. The noncapturing eraser preserves the compiler's unit/union channel ABI
/// and creates an ordinary EffectValue only when the program executes.
pub fn effect_succeed_owned<T: HeapValue>(value: T, erase: fn(&T) -> EffectValue) -> JsEffect {
    effect_new(EffectNode::SucceedOwned(Box::new(OwnedEffectValue { value, evaluate: erase })))
}

/// Retains one native callback rather than capturing separate copies in an
/// erased thunk and its trace closure. The callback runs only on execution;
/// tracing enumerates its one stored owning edge without calling user code.
pub fn effect_sync_owned<T: HeapValue>(callback: T, invoke: fn(&T) -> EffectValue) -> JsEffect {
    effect_new(EffectNode::SyncOwned(Box::new(OwnedEffectValue { value: callback, evaluate: invoke })))
}
