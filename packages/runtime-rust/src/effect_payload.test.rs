struct EffectPayloadCycle {
    effect: Option<JsEffect>,
    value: f64,
}

impl Trace for EffectPayloadCycle {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(effect) = &self.effect { tracer.edge(effect); }
    }
}

impl ClearEdges for EffectPayloadCycle {
    fn clear_edges(&mut self) { self.effect = None; }
}

#[test]
fn effect_succeed_payload_back_edge_is_collected_after_last_owner_drops() {
    let value = Gc::new(EffectPayloadCycle { effect: None, value: 42.0 });
    let effect = effect_succeed_owned(value.clone(), |value| effect_box(value.clone()));
    value.with_mut(|value| value.effect = Some(effect.clone()));
    let weak_value = value.downgrade();
    let weak_effect = effect.downgrade();
    drop((value, effect));
    let collected = collect_cycles();
    let retained_value = weak_value.upgrade();
    let retained_effect = weak_effect.upgrade();
    let released = retained_value.is_none() && retained_effect.is_none();
    // Keep a failing run isolated: break any leaked cycle before asserting.
    if let Some(value) = &retained_value { value.with_mut(ClearEdges::clear_edges); }
    drop((retained_value, retained_effect));
    assert!(released, "Effect.succeed payload cycle leaked; collector freed {collected} nodes");
    assert_eq!(collected, 2);
}

#[test]
fn effect_succeed_owned_payload_keeps_live_aliases_and_mutations_after_execution() {
    let value = Gc::new(EffectPayloadCycle { effect: None, value: 42.0 });
    let effect = effect_succeed_owned(value.clone(), |value| effect_box(value.clone()));
    value.with_mut(|value| value.effect = Some(effect.clone()));
    let weak_value = value.downgrade();
    let weak_effect = effect.downgrade();
    let first = effect_run_sync(&effect);
    let recovered = effect_unbox::<Gc<EffectPayloadCycle>>(&first);
    assert!(recovered.ptr_eq(&value));
    recovered.with_mut(|value| value.value = 43.0);
    let next = effect_unbox::<Gc<EffectPayloadCycle>>(&effect_run_sync(&effect));
    assert!(next.ptr_eq(&recovered));
    assert_eq!(next.with(|value| value.value), 43.0);
    drop((value, effect, recovered, next));
    assert_eq!(collect_cycles(), 0, "the external channel payload retains the record");
    assert!(weak_value.upgrade().is_some());
    assert!(weak_effect.upgrade().is_some());
    drop(first);
    assert_eq!(collect_cycles(), 2);
    assert!(weak_value.upgrade().is_none());
    assert!(weak_effect.upgrade().is_none());
}

#[test]
fn effect_succeed_owned_values_count_independent_owners_of_one_shared_record() {
    let value = Gc::new(EffectPayloadCycle { effect: None, value: 42.0 });
    let first = effect_succeed_owned(value.clone(), |value| effect_box(value.clone()));
    let second = effect_succeed_owned(value.clone(), |value| effect_box(value.clone()));
    value.with_mut(|value| value.effect = Some(first.clone()));
    let weak_value = value.downgrade();
    let weak_first = first.downgrade();
    drop((value, first));
    assert_eq!(collect_cycles(), 0, "the second Effect is an external owner");
    assert!(weak_first.upgrade().is_some());
    let recovered = effect_unbox::<Gc<EffectPayloadCycle>>(&effect_run_sync(&second));
    assert_eq!(recovered.with(|value| value.value), 42.0);
    drop((recovered, second));
    assert_eq!(collect_cycles(), 2);
    assert!(weak_value.upgrade().is_none());
    assert!(weak_first.upgrade().is_none());
}

thread_local! { static EFFECT_OWNED_ERASURES: Cell<usize> = const { Cell::new(0) }; }

#[test]
fn effect_succeed_owned_eraser_is_deferred_and_retains_unit_channel_distinctions() {
    let effect = effect_succeed_owned((), |_| {
        EFFECT_OWNED_ERASURES.with(|runs| runs.set(runs.get() + 1));
        effect_box(EffectUnit::Null)
    });
    EFFECT_OWNED_ERASURES.with(|runs| assert_eq!(runs.get(), 0));
    assert_eq!(effect_reference_typeof(&effect), "object");
    collect_cycles();
    EFFECT_OWNED_ERASURES.with(|runs| assert_eq!(runs.get(), 0));
    assert!(matches!(effect_unbox::<EffectUnit>(&effect_run_sync(&effect)), EffectUnit::Null));
    assert!(matches!(effect_unbox::<EffectUnit>(&effect_run_sync(&effect)), EffectUnit::Null));
    EFFECT_OWNED_ERASURES.with(|runs| assert_eq!(runs.get(), 2));
}

struct EffectPayloadCallback { value: Option<Gc<EffectPayloadCycle>> }
impl Trace for EffectPayloadCallback {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(value) = &self.value { tracer.edge(value); }
    }
}
impl ClearEdges for EffectPayloadCallback {
    fn clear_edges(&mut self) { self.value = None; }
}
fn effect_payload_callback(callback: &Gc<EffectPayloadCallback>) -> EffectValue {
    callback.with(|callback| callback.value.as_ref().expect("live capture").with_mut(|value| {
        value.value += 1.0;
        effect_box(value.effect.clone().expect("captured effect"))
    }))
}

#[test]
fn effect_sync_callback_back_edge_is_collected_after_last_owner_drops() {
    let value = Gc::new(EffectPayloadCycle { effect: None, value: 0.0 });
    let callback = Gc::new(EffectPayloadCallback { value: Some(value.clone()) });
    let weak_callback = callback.downgrade();
    let effect = effect_sync_owned(callback, effect_payload_callback);
    value.with_mut(|value| value.effect = Some(effect.clone()));
    let weak_value = value.downgrade();
    let weak_effect = effect.downgrade();
    let recovered = effect_unbox::<JsEffect>(&effect_run_sync(&effect));
    assert!(recovered.ptr_eq(&effect));
    drop((value, effect, recovered));
    let collected = collect_cycles();
    let retained_value = weak_value.upgrade();
    let retained_effect = weak_effect.upgrade();
    let retained_callback = weak_callback.upgrade();
    let released = retained_value.is_none() && retained_effect.is_none() && retained_callback.is_none();
    if let Some(value) = &retained_value { value.with_mut(ClearEdges::clear_edges); }
    drop((retained_value, retained_effect, retained_callback));
    assert!(released, "Effect.sync callback cycle leaked; collector freed {collected} nodes");
    assert_eq!(collected, 3);
}

#[test]
fn effect_sync_owned_retains_external_results_and_repeats_deferred_callbacks() {
    let value = Gc::new(EffectPayloadCycle { effect: None, value: 0.0 });
    let callback = Gc::new(EffectPayloadCallback { value: Some(value.clone()) });
    let weak_callback = callback.downgrade();
    let effect = effect_sync_owned(callback, effect_payload_callback);
    value.with_mut(|value| value.effect = Some(effect.clone()));
    let weak_value = value.downgrade();
    let weak_effect = effect.downgrade();
    assert_eq!(value.with(|value| value.value), 0.0);
    assert_eq!(collect_cycles(), 0);
    assert_eq!(value.with(|value| value.value), 0.0, "tracing must not invoke callbacks");
    let first = effect_run_sync(&effect);
    let second = effect_run_sync(&effect);
    assert!(effect_unbox::<JsEffect>(&first).ptr_eq(&effect));
    assert!(effect_unbox::<JsEffect>(&second).ptr_eq(&effect));
    assert_eq!(value.with(|value| value.value), 2.0);
    drop((value, effect, second));
    assert_eq!(collect_cycles(), 0, "an external result keeps the whole graph live");
    assert!(weak_callback.upgrade().is_some());
    assert!(weak_value.upgrade().is_some());
    assert!(weak_effect.upgrade().is_some());
    drop(first);
    assert_eq!(collect_cycles(), 3);
    assert!(weak_callback.upgrade().is_none());
    assert!(weak_value.upgrade().is_none());
    assert!(weak_effect.upgrade().is_none());
}
