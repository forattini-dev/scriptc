/// Effect.addFinalizer/acquireRelease retain the services from registration.
/// Installing a complete snapshot avoids inheriting services introduced only
/// at cleanup, and the continuation restores the closing context on any exit.
fn capture_finalizer_context(finalizer: FinalizerFn, env: &[(JsString, EffectValue)]) -> FinalizerFn {
    let captured = Rc::new(env.to_vec());
    Rc::new(move |exit| effect_new(EffectNode::WithContext(finalizer(exit), captured.clone())))
}

/// An open scope: its finalizers in registration order. Shared, so a context snapshot can hand the scope out
/// (`Context.getUnsafe(fiber.context, Scope.Scope)`) and `Scope.addFinalizer` can register into it later.
pub type EffectScope = Rc<RefCell<Vec<FinalizerFn>>>;

/// The kernel's fiber value (`Effect.withFiber`, `Fiber.getCurrent()`): the services in scope and the innermost open
/// scope when the snapshot was taken.
pub struct EffectContextData {
    env: Vec<(JsString, EffectValue)>,
    scope: Option<EffectScope>,
}

const EFFECT_SCOPE_KEY: &str = "effect/Scope";

type ReferenceDefault = (Rc<dyn Fn() -> EffectValue>, Option<EffectValue>);

thread_local! {
    static EFFECT_CURRENT_FIBERS: RefCell<Vec<FiberRef>> = const { RefCell::new(Vec::new()) };
    static EFFECT_REFERENCE_DEFAULTS: RefCell<HashMap<String, ReferenceDefault>> = RefCell::new(HashMap::new());
}

fn effect_fiber_enter(fiber: &FiberRef) {
    EFFECT_CURRENT_FIBERS.with(|fibers| fibers.borrow_mut().push(fiber.clone()));
}

fn effect_fiber_leave() {
    EFFECT_CURRENT_FIBERS.with(|fibers| {
        fibers.borrow_mut().pop();
    });
}

/// `Context.Reference(id, { defaultValue })`: a service key whose lookup falls back to the default, computed once.
pub fn effect_reference_key(id: &JsString, default: Rc<dyn Fn() -> EffectValue>) -> JsEffect {
    EFFECT_REFERENCE_DEFAULTS.with(|defaults| {
        defaults.borrow_mut().entry(id.to_string()).or_insert((default, None));
    });
    effect_service_key(id)
}

fn effect_reference_default(key: &JsString) -> Option<EffectValue> {
    let (thunk, cached) = EFFECT_REFERENCE_DEFAULTS.with(|defaults| defaults.borrow().get(&key.to_string()).map(|(thunk, value)| (thunk.clone(), value.clone())))?;
    if let Some(value) = cached {
        return Some(value);
    }
    let value = thunk();
    EFFECT_REFERENCE_DEFAULTS.with(|defaults| {
        if let Some(slot) = defaults.borrow_mut().get_mut(&key.to_string()) {
            slot.1 = Some(value.clone());
        }
    });
    Some(value)
}

/// A service lookup: the innermost provide wins, then a reference's default.
fn context_lookup(env: &[(JsString, EffectValue)], key: &JsString) -> Option<EffectValue> {
    env.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone()).or_else(|| effect_reference_default(key))
}

fn effect_current_context() -> JsEffect {
    let snapshot = EFFECT_CURRENT_FIBERS.with(|fibers| {
        fibers.borrow().last().map(|fiber| {
            let state = fiber.borrow();
            (state.env.clone(), state.scopes.last().cloned())
        })
    });
    let (env, scope) = snapshot.unwrap_or_default();
    effect_new(EffectNode::Data(KernelData::Context(Rc::new(EffectContextData { env, scope }))))
}

pub fn effect_with_fiber(read: Rc<dyn Fn(JsEffect) -> JsEffect>, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::WithFiber(read, trace))
}

/// `Fiber.getCurrent()`: the running fiber's context snapshot.
pub fn effect_fiber_current() -> JsEffect {
    effect_current_context()
}

fn effect_context_data(handle: &JsEffect) -> Rc<EffectContextData> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Context(context)) => context.clone(),
        _ => throw_error("scriptc: a fiber context was expected".to_owned()),
    })
}

/// `Context.get/getUnsafe(context, key)`: `Scope.Scope` answers the snapshot's innermost scope.
pub fn effect_context_get(context: &JsEffect, key: &JsEffect) -> EffectValue {
    let data = effect_context_data(context);
    let id = key_of(key);
    if id.to_string() == EFFECT_SCOPE_KEY {
        return match &data.scope {
            Some(scope) => effect_box(effect_new(EffectNode::Data(KernelData::Scope(scope.clone())))),
            None => throw_error(format!("Service not found: {EFFECT_SCOPE_KEY}")),
        };
    }
    context_lookup(&data.env, &id).unwrap_or_else(|| throw_error(format!("Service not found: {id}")))
}

/// `Context.getOption(context, key)`.
pub fn effect_context_get_option(context: &JsEffect, key: &JsEffect) -> JsEffect {
    let data = effect_context_data(context);
    match context_lookup(&data.env, &key_of(key)) {
        Some(value) => option_some(value),
        None => option_none(),
    }
}

/// `Effect.serviceOption(key)`: the Option of the service in scope when the effect runs.
pub fn effect_service_option(key: &JsEffect) -> JsEffect {
    let key = key.clone();
    let keep = key.clone();
    effect_with_fiber(
        Rc::new(move |context| effect_succeed(effect_box(effect_context_get_option(&context, &key)))),
        Box::new(move |tracer: &mut Tracer<'_>| tracer.edge(&keep)),
    )
}

/// `Scope.Scope`: the key a context snapshot answers with its open scope.
pub fn effect_scope_key() -> JsEffect {
    effect_service_key(&string(EFFECT_SCOPE_KEY))
}

/// `Scope.addFinalizer(scope, effect)`: registers into that scope with the registering fiber's services.
pub fn effect_scope_add_finalizer(scope: &JsEffect, finalizer: &JsEffect) -> JsEffect {
    let target = scope.with(|data| match &data.node {
        EffectNode::Data(KernelData::Scope(scope)) => scope.clone(),
        _ => throw_error("scriptc: a Scope handle was expected".to_owned()),
    });
    let finalizer = finalizer.clone();
    let keep = finalizer.clone();
    effect_sync(
        Rc::new(move || {
            let registered = finalizer.clone();
            let env = EFFECT_CURRENT_FIBERS.with(|fibers| fibers.borrow().last().map(|fiber| fiber.borrow().env.clone())).unwrap_or_default();
            target.borrow_mut().push(capture_finalizer_context(Rc::new(move |_exit| registered.clone()), &env));
            effect_box(())
        }),
        Box::new(move |tracer: &mut Tracer<'_>| tracer.edge(&keep)),
    )
}

/// `semaphore.take(n)`: parks until n permits are free, then answers n (effect's `Effect<number>`).
pub fn effect_semaphore_take_permits(handle: &JsEffect, permits: f64) -> JsEffect {
    effect_as(&effect_semaphore_take(&latch_of(handle, "Semaphore"), permits), effect_box(permits))
}

/// `semaphore.release(n)`: returns n permits, handing them to eligible waiters, and answers the permits then free.
pub fn effect_semaphore_release_permits(handle: &JsEffect, permits: f64) -> JsEffect {
    let latch = latch_of(handle, "Semaphore");
    let observed = latch.clone();
    effect_map(
        &effect_semaphore_release(&latch, permits),
        Rc::new(move |_| effect_box(observed.borrow().free())),
        Box::new(|_: &mut Tracer<'_>| {}),
    )
}

fn effect_context_finish() {
    EFFECT_REFERENCE_DEFAULTS.with(|defaults| defaults.borrow_mut().clear());
    EFFECT_CURRENT_FIBERS.with(|fibers| fibers.borrow_mut().clear());
}
