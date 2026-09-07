/// Effect.addFinalizer/acquireRelease retain the services from registration.
/// Installing a complete snapshot avoids inheriting services introduced only
/// at cleanup, and the continuation restores the closing context on any exit.
fn capture_finalizer_context(finalizer: FinalizerFn, env: &[(Rc<str>, EffectValue)]) -> FinalizerFn {
    let captured = Rc::new(env.to_vec());
    Rc::new(move |exit| effect_new(EffectNode::WithContext(finalizer(exit), captured.clone())))
}
