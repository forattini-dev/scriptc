/// Execute the actual scope continuation to build a mixed cause in LIFO
/// order: interruption, defect, first typed failure, second typed failure.
fn mixed_finalizer_scope() -> JsEffect {
    let mut body = effect_fail(effect_box(99.0));
    for reason in [
        EffectFailure::Interrupt,
        EffectFailure::Die(effect_box(7.0)),
        EffectFailure::Fail(effect_box(1.0)),
        EffectFailure::Fail(effect_box(2.0)),
    ] {
        let register = effect_add_finalizer(Rc::new(move |exit| {
            let Err(original) = exit_of(&exit) else { panic!("failed body exit") };
            assert_eq!(effect_unbox::<f64>(&original.into_value()), 99.0);
            reason.clone().into_effect()
        }), super::no_trace());
        body = effect_zip_right(&register, &body);
    }
    effect_scoped(&body)
}

fn observed_effect_failure(effect: &JsEffect) -> EffectFailure {
    let exit = effect_unbox::<JsEffect>(&effect_run_sync(&effect_exit(effect)));
    match exit_of(&exit) { Err(failure) => failure, Ok(_) => panic!("expected failure") }
}

#[test]
fn combined_finalizer_causes_keep_order_and_typed_failure_priority() {
    let cause = observed_effect_failure(&mixed_finalizer_scope());
    assert!(cause.has(0));
    assert!(cause.has(1));
    assert!(!cause.has(2));
    assert_eq!(effect_unbox::<f64>(&cause.clone().into_value()), 1.0);
    let EffectFailure::Combined(reasons) = cause else { panic!("expected combined finalizer failures") };
    assert_eq!(reasons.len(), 4);
    assert!(matches!(reasons[0], EffectFailure::Interrupt));
    assert!(matches!(reasons[1], EffectFailure::Die(_)));
}

#[test]
fn typed_recovery_uses_first_failure_and_taps_preserve_the_whole_cause() {
    let source = mixed_finalizer_scope();
    let handler: EffectFn = Rc::new(|value| effect_succeed(effect_box(effect_unbox::<f64>(&value) + 10.0)));
    let recovered = effect_catch_all(&source, handler.clone(), super::no_trace());
    assert_eq!(effect_unbox::<f64>(&effect_run_sync(&recovered)), 11.0);
    let conditional = effect_catch_if(&source, Rc::new(|_| true), handler.clone(), super::no_trace());
    assert_eq!(effect_unbox::<f64>(&effect_run_sync(&conditional)), 11.0);
    let fallback = effect_or_else_succeed(&source, Rc::new(|| effect_box(5.0)), super::no_trace());
    assert_eq!(effect_unbox::<f64>(&effect_run_sync(&fallback)), 5.0);
    effect_unbox::<()>(&effect_run_sync(&effect_ignore(&source)));

    let mapped = effect_map_error(&source, Rc::new(|value| effect_box(effect_unbox::<f64>(&value) + 10.0)), super::no_trace());
    let mapped = observed_effect_failure(&mapped);
    assert!(matches!(mapped, EffectFailure::Fail(_)));
    assert_eq!(effect_unbox::<f64>(&mapped.into_value()), 11.0);
    let died = observed_effect_failure(&effect_or_die(&source));
    assert!(matches!(died, EffectFailure::Die(_)));
    assert_eq!(effect_unbox::<f64>(&died.into_value()), 1.0);

    let skipped = effect_catch_if(&source, Rc::new(|_| false), handler, super::no_trace());
    let tapped = effect_tap_error(&source, Rc::new(|value| {
        assert_eq!(effect_unbox::<f64>(&value), 1.0);
        effect_succeed(effect_box(()))
    }), super::no_trace());
    for unchanged in [skipped, tapped] {
        let cause = observed_effect_failure(&unchanged);
        assert!(cause.has(0));
        assert!(cause.has(1));
        assert!(!cause.has(2));
        assert_eq!(effect_unbox::<f64>(&cause.into_value()), 1.0);
    }
}
