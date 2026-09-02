/* A non-blocking bridge from the Boa realm's Promise to the native typed
 * promise used by generated Rust. The bridge deliberately stores only a
 * numeric id in Boa callbacks: native promises belong to scriptc's traced
 * heap, not Boa's garbage collector, and must never be hidden in an
 * untraceable engine closure. */

type IslandPromiseSettlement = Box<dyn FnOnce(Result<IslandValue, Caught>)>;

thread_local! {
    static ISLAND_PROMISE_SETTLEMENTS: RefCell<HashMap<u64, IslandPromiseSettlement>> = RefCell::new(HashMap::new());
    static ISLAND_PROMISE_SETTLEMENT_ID: Cell<u64> = const { Cell::new(0) };
}

fn island_promise_next_id() -> u64 {
    ISLAND_PROMISE_SETTLEMENT_ID.with(|slot| {
        let id = slot.get().checked_add(1).unwrap_or(1);
        slot.set(id);
        id
    })
}

fn island_promise_fulfill(id: u64, value: JsValue) {
    let settle = ISLAND_PROMISE_SETTLEMENTS.with(|slot| slot.borrow_mut().remove(&id));
    if let Some(settle) = settle {
        settle(Ok(IslandValue(value)));
    }
}

fn island_promise_reject(id: u64, reason: Caught) {
    let settle = ISLAND_PROMISE_SETTLEMENTS.with(|slot| slot.borrow_mut().remove(&id));
    if let Some(settle) = settle {
        settle(Err(reason));
    }
}

/// Adopt an engine promise without driving the native event loop at the
/// call site. This preserves JavaScript's synchronous ordering: code after
/// `const pending = fetch(...)` runs before the fetch settles and can abort
/// it. Rejections use the same engine-error conversion as the former
/// blocking bridge, so typed catches retain their Node-facing error shape.
pub fn island_promise_bridge<T, F>(value: &IslandValue, map: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce(IslandValue) -> T + 'static,
{
    let target = promise_new();
    let settlement_target = target.clone();
    let id = island_promise_next_id();
    ISLAND_PROMISE_SETTLEMENTS.with(|slot| {
        slot.borrow_mut().insert(
            id,
            Box::new(move |outcome| match outcome {
                Ok(value) => {
                    let _ = promise_fulfill(&settlement_target, map(value));
                }
                Err(reason) => {
                    let _ = promise_reject(&settlement_target, reason);
                }
            }),
        );
    });
    with_island_state(|state| {
        let promise = BoaJsPromise::resolve(value.0.clone(), &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        let fulfilled = NativeFunction::from_copy_closure(move |_this, arguments, _context| {
            island_promise_fulfill(id, arguments.first().cloned().unwrap_or_default());
            Ok(JsValue::undefined())
        });
        let rejected = NativeFunction::from_copy_closure(move |_this, arguments, context| {
            let error = BoaJsError::from_opaque(arguments.first().cloned().unwrap_or_default());
            island_promise_reject(id, island_error_caught(error, context));
            Ok(JsValue::undefined())
        });
        promise.then(
            Some(fulfilled.to_js_function(state.context.realm())),
            Some(rejected.to_js_function(state.context.realm())),
            &mut state.context,
        ).unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        island_run_jobs(state);
    });
    target
}

fn island_promise_bridges_reset() {
    ISLAND_PROMISE_SETTLEMENTS.with(|slot| slot.borrow_mut().clear());
    ISLAND_PROMISE_SETTLEMENT_ID.with(|slot| slot.set(0));
}
