#[test]
fn finalizer_services_are_retained_until_cleanup_then_released() {
    let key = effect_service_key(&string("payload"));
    let payload = effect_box(vec![7u8; 4096]);
    let weak = Rc::downgrade(&payload);
    let lookup = key.clone();
    let register = effect_add_finalizer(Rc::new(move |_| {
        effect_map(&lookup, Rc::new(|value| {
            assert_eq!(effect_unbox::<Vec<u8>>(&value).len(), 4096);
            effect_box(())
        }), super::no_trace())
    }), super::no_trace());
    let provided = effect_provide_service(&register, &key, payload.clone());
    let program = effect_exit(&effect_scoped(&provided));
    let exit = effect_unbox::<JsEffect>(&effect_run_sync(&program));
    assert!(effect_exit_is_success(&exit), "cleanup must retain its registration-only service");
    drop((payload, key, register, provided, program, exit));
    assert!(weak.upgrade().is_none(), "completed finalizers must release captured service values");
}

#[test]
fn captured_context_does_not_inherit_services_from_cleanup() {
    // Drive the internal context boundary directly: registration captured no
    // services, even though the caller closing the finalizer has this key.
    let key = effect_service_key(&string("closing-only"));
    let lookup = key.clone();
    let finalizer = capture_finalizer_context(Rc::new(move |_| lookup.clone()), &[]);
    let cleanup = finalizer(effect_exit_succeed(effect_box(())));
    let provided = effect_provide_service(&cleanup, &key, effect_box(7.0));
    let exit = effect_unbox::<JsEffect>(&effect_run_sync(&effect_exit(&provided)));
    assert!(!effect_exit_is_success(&exit), "a captured context must replace, not extend, the closing context");
}
