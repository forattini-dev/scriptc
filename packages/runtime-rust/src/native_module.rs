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
