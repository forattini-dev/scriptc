// Native modules are already linked into the executable. Their evaluation
// still starts after the current promise/microtask checkpoint, matching the
// asynchronous boundary of import() without loading source at runtime.
thread_local! {
    static NATIVE_MODULE_JOBS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
}

fn native_module_dispatch_one() -> bool {
    let task = NATIVE_MODULE_JOBS.with(|tasks| tasks.borrow_mut().pop_front());
    if let Some(task) = task {
        EVENT_PHASE.with(|phase| phase.set(3));
        task();
        true
    } else {
        false
    }
}

fn native_modules_finish() {
    NATIVE_MODULE_JOBS.with(|tasks| tasks.borrow_mut().clear());
}

/// An async module's already-started dependencies gate its body. The emitted
/// graph is responsible for starting siblings in source order and handling
/// strongly connected components before using this acyclic wait primitive.
struct ModuleDependencyWait<F: Trace + ClearEdges + 'static> {
    remaining: usize,
    complete: bool,
    target: Option<JsPromise<()>>,
    frame: Option<Gc<F>>,
    start: fn(Gc<F>) -> JsPromise<()>,
}

impl<F: Trace + ClearEdges + 'static> Trace for ModuleDependencyWait<F> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(target) = &self.target { tracer.edge(target); }
        if let Some(frame) = &self.frame { tracer.edge(frame); }
    }
}

impl<F: Trace + ClearEdges + 'static> ClearEdges for ModuleDependencyWait<F> {
    fn clear_edges(&mut self) { self.target = None; self.frame = None; }
}

fn module_wait_complete<F: Trace + ClearEdges + 'static>(state: &Gc<ModuleDependencyWait<F>>, result: Result<(), Caught>) {
    let target = state.with_mut(|state| {
        if state.complete { return None; }
        state.complete = true;
        state.frame = None;
        state.target.take()
    });
    if let Some(target) = target {
        match result {
            Ok(()) => { let _ = promise_fulfill(&target, ()); }
            Err(reason) => { let _ = promise_reject(&target, reason); }
        }
    }
}

fn module_body_completed<F: Trace + ClearEdges + 'static>(state: Gc<ModuleDependencyWait<F>>, result: Result<(), Caught>) {
    module_wait_complete(&state, result);
}

fn module_dependency_completed<F: Trace + ClearEdges + 'static>(state: Gc<ModuleDependencyWait<F>>, result: Result<(), Caught>) {
    if let Err(reason) = result {
        module_wait_complete(&state, Err(reason));
        return;
    }
    let start = state.with_mut(|state| {
        if state.complete { return None; }
        state.remaining -= 1;
        if state.remaining != 0 { return None; }
        Some((state.start, state.frame.take().expect("module frame already started")))
    });
    if let Some((start, frame)) = start {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(frame))) {
            Ok(evaluation) => promise_then_traced(&evaluation, state, module_body_completed::<F>),
            Err(payload) => module_wait_complete(&state, Err(caught_from_panic(payload))),
        }
    }
}

/// Wait for nonempty, already-started async dependencies and evaluate the
/// module body once. Promise reactions trace the frame and propagate failure.
pub fn module_evaluate_after<F: Trace + ClearEdges + 'static>(
    dependencies: &[JsPromise<()>],
    frame: Gc<F>,
    start: fn(Gc<F>) -> JsPromise<()>,
) -> JsPromise<()> {
    assert!(!dependencies.is_empty(), "module_evaluate_after needs an async dependency");
    let target = promise_new();
    let state = Gc::new(ModuleDependencyWait {
        remaining: dependencies.len(), complete: false,
        target: Some(target.clone()), frame: Some(frame), start,
    });
    for dependency in dependencies {
        promise_then_traced(dependency, state.clone(), module_dependency_completed::<F>);
    }
    target
}

/// Each import creates its own promise; evaluation and namespace caches are
/// owned by the emitted module initializer/builder, not by this call site.
pub fn module_import<T, F>(load: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce() -> JsPromise<T> + 'static,
{
    let result = promise_new();
    let target = result.clone();
    let context = async_context_capture();
    NATIVE_MODULE_JOBS.with(|tasks| {
        tasks.borrow_mut().push_back(Box::new(move || {
            let _context_guard = async_context_install(context);
            let guard = target.clone();
            promise_run_segment(&guard, move || {
                let evaluation = load();
                promise_then(
                    &evaluation,
                    Box::new(move |outcome| match outcome {
                        Ok(value) => {
                            let _ = promise_fulfill(&target, value);
                        }
                        Err(reason) => {
                            let _ = promise_reject(&target, reason);
                        }
                    }),
                );
            });
        }))
    });
    result
}

/// The evaluation record of one linked module. It is published before the
/// initializer runs, so concurrent and reentrant requests observe the same
/// evaluation, including its rejection and namespace identity.
pub struct NativeModuleCache<T: HeapValue> {
    evaluation: Option<JsPromise<T>>,
}

impl<T: HeapValue> Trace for NativeModuleCache<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(evaluation) = &self.evaluation { tracer.edge(evaluation); }
    }
}

impl<T: HeapValue> ClearEdges for NativeModuleCache<T> {
    fn clear_edges(&mut self) { self.evaluation = None; }
}

pub fn module_cache_new<T: HeapValue>() -> Gc<NativeModuleCache<T>> {
    Gc::new(NativeModuleCache { evaluation: None })
}

fn module_cache_completed<T: HeapValue>(cache: Gc<NativeModuleCache<T>>, outcome: Result<T, Caught>) {
    let evaluation = cache.with(|state| state.evaluation.clone());
    if let Some(evaluation) = evaluation {
        match outcome {
            Ok(value) => { let _ = promise_fulfill(&evaluation, value); }
            Err(reason) => { let _ = promise_reject(&evaluation, reason); }
        }
    }
}

/// Return a fresh import promise while sharing one lazily started evaluation.
/// `load` is called at most once, in the module job, and may itself be async.
pub fn module_import_cached<T, F>(cache: Gc<NativeModuleCache<T>>, load: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce() -> JsPromise<T> + 'static,
{
    module_import(move || module_cache_evaluate(cache, load))
}

fn module_cache_evaluate<T, F>(cache: Gc<NativeModuleCache<T>>, load: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce() -> JsPromise<T>,
{
    let (evaluation, start) = cache.with_mut(|state| {
        if let Some(evaluation) = &state.evaluation {
            (evaluation.clone(), false)
        } else {
            let evaluation = promise_new();
            state.evaluation = Some(evaluation.clone());
            (evaluation, true)
        }
    });
    if start {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(load)) {
            Ok(source) => promise_then_traced(&source, cache, module_cache_completed::<T>),
            Err(payload) => { let _ = promise_reject(&evaluation, caught_from_panic(payload)); }
        }
    }
    evaluation
}

/// Import sites share evaluation while projecting their own typed export view.
pub fn module_import_cached_map<T, U, F, M>(
    cache: Gc<NativeModuleCache<T>>, load: F, project: M,
) -> JsPromise<U>
where
    T: HeapValue,
    U: HeapValue,
    F: FnOnce() -> JsPromise<T> + 'static,
    M: FnOnce(T) -> U + 'static,
{
    module_import(move || {
        let evaluation = module_cache_evaluate(cache, load);
        let result = promise_new();
        let target = result.clone();
        promise_then(&evaluation, Box::new(move |outcome| {
            let guard = target.clone();
            promise_run_segment(&guard, move || match outcome {
                Ok(value) => { let _ = promise_fulfill(&target, project(value)); }
                Err(reason) => { let _ = promise_reject(&target, reason); }
            });
        }));
        result
    })
}

/// Reentrant synchronous evaluation is a cache hit. Failed ESM evaluation
/// remains failed, including when reached through a different importer.
pub fn module_cached_sync(evaluation: &JsPromise<()>) {
    if let Some(Err(reason)) = promise_poll(evaluation) {
        rethrow_caught(reason);
    }
}

/// The emitter publishes this promise before invoking the body. Preserve
/// synchronous static-import order while recording the exact thrown value.
pub fn module_evaluate_sync(evaluation: &JsPromise<()>, action: impl FnOnce()) {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(action)) {
        Ok(()) => {
            let _ = promise_fulfill(evaluation, ());
        }
        Err(payload) => {
            let reason = caught_from_panic(payload);
            let _ = promise_reject(evaluation, reason.clone());
            // The cache is an internal evaluation record, never an unhandled
            // user promise. The caller receives the original synchronous throw.
            let _ = promise_poll(evaluation);
            rethrow_caught(reason);
        }
    }
}
