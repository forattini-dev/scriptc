/// A typed value that can live inside a captured JavaScript binding.
///
/// Generated closures store bindings as traced `Gc` cells. Scalar and string
/// values have no outgoing heap edges; owning `Gc` handles expose their edge
/// to the cycle collector. Generated union values implement this trait by
/// delegating to their generated `Trace` implementation.
pub trait HeapValue: Clone + 'static {
    fn trace_value(&self, _tracer: &mut Tracer<'_>) {}
}

impl HeapValue for f64 {}
impl HeapValue for bool {}
impl HeapValue for usize {}
impl HeapValue for () {}
impl HeapValue for JsString {}
impl HeapValue for JsRegex {}
impl HeapValue for JsSymbol {}
impl HeapValue for JsUrl {}
impl HeapValue for JsSearchParams {}
impl HeapValue for JsError {}
impl HeapValue for Caught {}

impl<T> HeapValue for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn trace_value(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(self);
    }
}

type PromiseReaction<T> = Box<dyn FnOnce(Result<T, Caught>)>;

enum PromiseState<T: HeapValue> {
    Pending(Vec<PromiseReaction<T>>),
    Fulfilled(Option<T>),
    Rejected(Option<Caught>),
}

pub struct PromiseData<T: HeapValue> {
    state: PromiseState<T>,
    handled: bool,
    reported: bool,
}

impl<T: HeapValue> Trace for PromiseData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let PromiseState::Fulfilled(Some(value)) = &self.state {
            value.trace_value(tracer);
        }
    }
}

impl<T: HeapValue> ClearEdges for PromiseData<T> {
    fn clear_edges(&mut self) {
        self.state = PromiseState::Pending(Vec::new());
        self.handled = true;
    }
}

pub type JsPromise<T> = Gc<PromiseData<T>>;

pub fn promise_new<T: HeapValue>() -> JsPromise<T> {
    Gc::new(PromiseData {
        state: PromiseState::Pending(Vec::new()),
        handled: false,
        reported: false,
    })
}

pub fn promise_resolved<T: HeapValue>(value: T) -> JsPromise<T> {
    Gc::new(PromiseData {
        state: PromiseState::Fulfilled(Some(value)),
        handled: false,
        reported: false,
    })
}

pub fn promise_rejected<T: HeapValue>(reason: Caught) -> JsPromise<T> {
    let promise = promise_new();
    let _ = promise_reject(&promise, reason);
    promise
}

pub fn promise_from_sync<T, F>(operation: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce() -> T + 'static,
{
    let result = promise_new();
    let guard = result.clone();
    let target = result.clone();
    promise_run_segment(&guard, move || {
        let value = operation();
        let _ = promise_fulfill(&target, value);
    });
    result
}

pub fn promise_timeout(delay_ms: f64) -> JsPromise<()> {
    let promise = promise_new();
    let result = promise.clone();
    timer_set_timeout(
        Box::new(move || {
            let _ = promise_fulfill(&result, ());
        }),
        delay_ms,
    );
    promise
}

pub fn promise_immediate() -> JsPromise<()> {
    let promise = promise_new();
    let result = promise.clone();
    let _ = timer_set_immediate(Box::new(move || {
        let _ = promise_fulfill(&result, ());
    }));
    promise
}

pub fn promise_race<T: HeapValue>(entries: Vec<JsPromise<T>>) -> JsPromise<T> {
    let result = promise_new();
    for entry in entries {
        let target = result.clone();
        promise_then(
            &entry,
            Box::new(move |outcome| match outcome {
                Ok(value) => {
                    let _ = promise_fulfill(&target, value);
                }
                Err(reason) => {
                    let _ = promise_reject(&target, reason);
                }
            }),
        );
    }
    result
}

pub fn promise_race_add<T, U, F>(result: &JsPromise<U>, entry: &JsPromise<T>, adapt: F)
where
    T: HeapValue,
    U: HeapValue,
    F: FnOnce(T) -> U + 'static,
{
    let target = result.clone();
    promise_then(
        entry,
        Box::new(move |outcome| match outcome {
            Ok(value) => {
                let _ = promise_fulfill(&target, adapt(value));
            }
            Err(reason) => {
                let _ = promise_reject(&target, reason);
            }
        }),
    );
}

pub fn promise_all<T>(entries: &JsArray<JsPromise<T>>) -> JsPromise<JsArray<T>>
where
    T: HeapValue + ArrayElement,
{
    let entries = entries.with(|data| data.elements.clone());
    if entries.is_empty() {
        return promise_resolved(array_new(Vec::new()));
    }

    struct State<T>
    where
        T: HeapValue + ArrayElement,
    {
        result: JsPromise<JsArray<T>>,
        values: Vec<Option<T>>,
        remaining: usize,
        settled: bool,
    }

    let result = promise_new();
    let state = Rc::new(RefCell::new(State {
        result: result.clone(),
        values: vec![None; entries.len()],
        remaining: entries.len(),
        settled: false,
    }));
    for (index, entry) in entries.into_iter().enumerate() {
        let state = state.clone();
        promise_then(
            &entry,
            Box::new(move |outcome| {
                let action = {
                    let mut state = state.borrow_mut();
                    if state.settled {
                        return;
                    }
                    match outcome {
                        Ok(value) => {
                            state.values[index] = Some(value);
                            state.remaining -= 1;
                            if state.remaining != 0 {
                                return;
                            }
                            state.settled = true;
                            let values = std::mem::take(&mut state.values)
                                .into_iter()
                                .map(|value| value.expect("scriptc: missing Promise.all value"))
                                .collect();
                            (state.result.clone(), Ok(array_new(values)))
                        }
                        Err(reason) => {
                            state.settled = true;
                            state.values.clear();
                            (state.result.clone(), Err(reason))
                        }
                    }
                };
                match action {
                    (result, Ok(values)) => {
                        let _ = promise_fulfill(&result, values);
                    }
                    (result, Err(reason)) => {
                        let _ = promise_reject(&result, reason);
                    }
                }
            }),
        );
    }
    result
}

pub fn promise_all_void(entries: &JsArray<JsPromise<()>>) -> JsPromise<()> {
    let entries = entries.with(|data| data.elements.clone());
    if entries.is_empty() {
        return promise_resolved(());
    }

    struct State {
        result: JsPromise<()>,
        remaining: usize,
        settled: bool,
    }

    let result = promise_new();
    let state = Rc::new(RefCell::new(State {
        result: result.clone(),
        remaining: entries.len(),
        settled: false,
    }));
    for entry in entries {
        let state = state.clone();
        promise_then(
            &entry,
            Box::new(move |outcome| {
                let action = {
                    let mut state = state.borrow_mut();
                    if state.settled {
                        return;
                    }
                    match outcome {
                        Ok(()) => {
                            state.remaining -= 1;
                            if state.remaining != 0 {
                                return;
                            }
                            state.settled = true;
                            (state.result.clone(), Ok(()))
                        }
                        Err(reason) => {
                            state.settled = true;
                            (state.result.clone(), Err(reason))
                        }
                    }
                };
                match action {
                    (result, Ok(())) => {
                        let _ = promise_fulfill(&result, ());
                    }
                    (result, Err(reason)) => {
                        let _ = promise_reject(&result, reason);
                    }
                }
            }),
        );
    }
    result
}

fn promise_schedule<T: HeapValue>(reaction: PromiseReaction<T>, outcome: Result<T, Caught>) {
    timer_queue_microtask(Box::new(move || reaction(outcome)));
}

pub fn promise_then<T: HeapValue>(promise: &JsPromise<T>, reaction: PromiseReaction<T>) {
    let mut reaction = Some(reaction);
    let settled = promise.with_mut(|data| {
        data.handled = true;
        match &mut data.state {
            PromiseState::Pending(reactions) => {
                reactions.push(reaction.take().expect("scriptc: missing promise reaction"));
                None
            }
            PromiseState::Fulfilled(value) => Some(Ok(value
                .as_ref()
                .expect("scriptc: cleared fulfilled promise")
                .clone())),
            PromiseState::Rejected(reason) => Some(Err(reason
                .as_ref()
                .expect("scriptc: cleared rejected promise")
                .clone())),
        }
    });
    if let Some(outcome) = settled {
        promise_schedule(
            reaction.expect("scriptc: settled promise consumed its reaction"),
            outcome,
        );
    }
}

pub fn promise_map<T, U, F>(promise: &JsPromise<T>, map: F) -> JsPromise<U>
where
    T: HeapValue,
    U: HeapValue,
    F: FnOnce(T) -> U + 'static,
{
    let result = promise_new();
    let target = result.clone();
    promise_then(
        promise,
        Box::new(move |outcome| match outcome {
            Ok(value) => {
                let guard = target.clone();
                promise_run_segment(&guard, move || {
                    let mapped = map(value);
                    let _ = promise_fulfill(&target, mapped);
                });
            }
            Err(reason) => {
                let _ = promise_reject(&target, reason);
            }
        }),
    );
    result
}

pub fn promise_fulfill<T: HeapValue>(promise: &JsPromise<T>, value: T) -> bool {
    let reactions = promise.with_mut(|data| match &mut data.state {
        PromiseState::Pending(reactions) => Some(std::mem::take(reactions)),
        PromiseState::Fulfilled(_) | PromiseState::Rejected(_) => None,
    });
    let Some(reactions) = reactions else {
        return false;
    };
    promise.with_mut(|data| data.state = PromiseState::Fulfilled(Some(value.clone())));
    for reaction in reactions {
        promise_schedule(reaction, Ok(value.clone()));
    }
    true
}

pub fn promise_reject<T: HeapValue>(promise: &JsPromise<T>, reason: Caught) -> bool {
    let reactions = promise.with_mut(|data| match &mut data.state {
        PromiseState::Pending(reactions) => Some(std::mem::take(reactions)),
        PromiseState::Fulfilled(_) | PromiseState::Rejected(_) => None,
    });
    let Some(reactions) = reactions else {
        return false;
    };
    promise.with_mut(|data| data.state = PromiseState::Rejected(Some(reason.clone())));
    for reaction in reactions {
        promise_schedule(reaction, Err(reason.clone()));
    }
    let candidate = promise.clone();
    PROMISE_CHECKS.with(|checks| {
        checks.borrow_mut().push_back(Box::new(move || {
            let unhandled = candidate.with_mut(|data| {
                if data.handled || data.reported {
                    return None;
                }
                let reason = match &data.state {
                    PromiseState::Rejected(Some(reason)) => reason.clone(),
                    PromiseState::Pending(_)
                    | PromiseState::Fulfilled(_)
                    | PromiseState::Rejected(None) => return None,
                };
                data.reported = true;
                Some(reason)
            });
            if let Some(reason) = unhandled {
                eprintln!("UnhandledPromiseRejection: {}", caught_to_string(&reason));
                UNHANDLED_REJECTION.with(|flag| flag.set(true));
            }
        }));
    });
    true
}

pub fn promise_unwrap<T: HeapValue>(outcome: Result<T, Caught>) -> T {
    match outcome {
        Ok(value) => value,
        Err(reason) => rethrow_caught(reason),
    }
}

pub fn promise_run_segment<T, F>(promise: &JsPromise<T>, segment: F)
where
    T: HeapValue,
    F: FnOnce(),
{
    if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(segment)) {
        let _ = promise_reject(promise, caught_from_panic(payload));
    }
}

pub enum AsyncCompletion<T> {
    Fallthrough,
    Suspended,
    Return(T),
}

pub fn promise_try_segment<T, F>(segment: F) -> Result<AsyncCompletion<T>, Caught>
where
    F: FnOnce() -> AsyncCompletion<T>,
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(segment)) {
        Ok(completion) => Ok(completion),
        Err(payload) => Err(caught_from_panic(payload)),
    }
}

/// Payload of a shared lexical binding captured by one or more closures.
pub struct CellData<T: HeapValue> {
    value: Option<T>,
}

impl<T: HeapValue> Trace for CellData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(value) = &self.value {
            value.trace_value(tracer);
        }
    }
}

impl<T: HeapValue> ClearEdges for CellData<T> {
    fn clear_edges(&mut self) {
        self.value = None;
    }
}

pub type JsCell<T> = Gc<CellData<T>>;

pub fn cell_new<T: HeapValue>(value: T) -> JsCell<T> {
    Gc::new(CellData { value: Some(value) })
}

pub fn cell_empty<T: HeapValue>() -> JsCell<T> {
    Gc::new(CellData { value: None })
}

pub fn cell_get<T: HeapValue>(cell: &JsCell<T>) -> T {
    cell.with(|data| {
        data.value
            .as_ref()
            .expect("scriptc: read of an uninitialized captured binding")
            .clone()
    })
}

pub fn cell_get_tdz<T: HeapValue>(cell: &JsCell<T>, binding_name: &str) -> T {
    cell.with(|data| match &data.value {
        Some(value) => value.clone(),
        None => throw_reference_error(format!(
            "Cannot access '{binding_name}' before initialization"
        )),
    })
}

pub fn cell_set<T: HeapValue>(cell: &JsCell<T>, value: T) {
    cell.with_mut(|data| data.value = Some(value));
}
