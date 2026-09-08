// A representation bridge is a view, not Promise resolution/adoption.
// Register reactions on the original promise so crossing a native value
// boundary neither schedules an extra job nor creates rejection ownership.
type PromisePollHook = Rc<dyn Fn() -> Option<Result<Box<dyn Any>, Caught>>>;

fn promise_view_outcome<T: HeapValue>(outcome: Result<Box<dyn Any>, Caught>) -> Result<T, Caught> {
    outcome.map(|value| {
        *value
            .downcast::<T>()
            .expect("scriptc: dynamic promise view payload type mismatch")
    })
}

pub fn promise_view_identity<T: HeapValue>(promise: &JsPromise<T>) -> usize {
    promise
        .with(|data| data.view.as_ref().map(|view| promise_handle_identity(view)))
        .unwrap_or_else(|| promise.identity())
}

pub fn promise_view_from_handle<T: HeapValue>(handle: &JsPromiseHandle) -> JsPromise<T> {
    Gc::new(PromiseData {
        state: PromiseState::Pending(Vec::new()),
        handled: true,
        reported: false,
        view: Some(Rc::new(handle.clone())),
    })
}

pub fn promise_view_map<T, U, F>(promise: &JsPromise<T>, map: F) -> JsPromise<U>
where
    T: HeapValue,
    U: HeapValue,
    F: Fn(T) -> U + 'static,
{
    promise_view_from_handle(&promise_to_mapped_handle(promise, map))
}

fn promise_view_map_outcome<T, U, F>(
    outcome: Result<T, Caught>,
    map: &F,
) -> Result<Box<dyn Any>, Caught>
where
    T: HeapValue,
    U: HeapValue,
    F: Fn(T) -> U,
{
    outcome.and_then(|value| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Box::new(map(value)) as Box<dyn Any>
        }))
        .map_err(caught_from_panic)
    })
}
