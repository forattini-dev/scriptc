#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GeneratorState {
    Unstarted,
    Suspended,
    Executing,
    Done,
}

pub enum GeneratorCommand<N, R> {
    Next(N),
    Return(Option<R>),
    Throw(Caught),
}

pub enum GeneratorStep<Y, R> {
    Yielded(Y),
    Returned(Option<R>),
}

type GeneratorContinuation<Y, R, N> =
    Box<dyn FnOnce(JsGenerator<Y, R, N>, GeneratorCommand<N, R>) -> GeneratorStep<Y, R>>;
type GeneratorPanicHandler<Y, R, N> =
    Box<dyn FnOnce(JsGenerator<Y, R, N>, Caught) -> GeneratorStep<Y, R>>;

struct GeneratorData<Y, R, N> {
    state: GeneratorState,
    continuation: Option<GeneratorContinuation<Y, R, N>>,
    panic_handlers: Vec<GeneratorPanicHandler<Y, R, N>>,
}

/// Safe, synchronous JavaScript generator handle. The suspended continuation
/// owns its typed cells; no native stack or unsafe coroutine support is used.
pub struct JsGenerator<Y, R, N>(Rc<RefCell<GeneratorData<Y, R, N>>>);

impl<Y, R, N> Clone for JsGenerator<Y, R, N> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<Y, R, N> HeapValue for JsGenerator<Y, R, N>
where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: Clone + 'static,
{
}

pub fn generator_new<Y, R, N, F>(start: F) -> JsGenerator<Y, R, N>
where
    F: FnOnce(JsGenerator<Y, R, N>, GeneratorCommand<N, R>) -> GeneratorStep<Y, R>
        + 'static,
{
    JsGenerator(Rc::new(RefCell::new(GeneratorData {
        state: GeneratorState::Unstarted,
        continuation: Some(Box::new(start)),
        panic_handlers: Vec::new(),
    })))
}

pub fn generator_push_panic_handler<Y, R, N, F>(generator: &JsGenerator<Y, R, N>, handler: F)
where
    F: FnOnce(JsGenerator<Y, R, N>, Caught) -> GeneratorStep<Y, R> + 'static,
{
    let mut data = generator.0.borrow_mut();
    assert_eq!(data.state, GeneratorState::Executing);
    data.panic_handlers.push(Box::new(handler));
}

pub fn generator_pop_panic_handler<Y, R, N>(generator: &JsGenerator<Y, R, N>) {
    let mut data = generator.0.borrow_mut();
    assert_eq!(data.state, GeneratorState::Executing);
    let _ = data
        .panic_handlers
        .pop()
        .expect("scriptc: generator panic-handler stack underflow");
}

pub fn generator_suspend<Y, R, N, F>(generator: &JsGenerator<Y, R, N>, continuation: F)
where
    F: FnOnce(JsGenerator<Y, R, N>, GeneratorCommand<N, R>) -> GeneratorStep<Y, R>
        + 'static,
{
    let mut data = generator.0.borrow_mut();
    assert_eq!(data.state, GeneratorState::Executing);
    assert!(data.continuation.is_none());
    data.state = GeneratorState::Suspended;
    data.continuation = Some(Box::new(continuation));
}

fn generator_resume<Y, R, N>(
    generator: &JsGenerator<Y, R, N>,
    command: GeneratorCommand<N, R>,
) -> GeneratorStep<Y, R> {
    let continuation = {
        let mut data = generator.0.borrow_mut();
        match data.state {
            GeneratorState::Done => {
                return match command {
                    GeneratorCommand::Next(_) => GeneratorStep::Returned(None),
                    GeneratorCommand::Return(value) => GeneratorStep::Returned(value),
                    GeneratorCommand::Throw(reason) => rethrow_caught(reason),
                };
            }
            GeneratorState::Executing => {
                throw_type_error("Generator is already running".to_owned());
            }
            GeneratorState::Unstarted => match command {
                GeneratorCommand::Return(value) => {
                    data.state = GeneratorState::Done;
                    data.continuation = None;
                    data.panic_handlers.clear();
                    return GeneratorStep::Returned(value);
                }
                GeneratorCommand::Throw(reason) => {
                    data.state = GeneratorState::Done;
                    data.continuation = None;
                    data.panic_handlers.clear();
                    rethrow_caught(reason);
                }
                GeneratorCommand::Next(value) => {
                    data.state = GeneratorState::Executing;
                    let continuation = data
                        .continuation
                        .take()
                        .expect("scriptc: unstarted generator without continuation");
                    drop(data);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        continuation(generator.clone(), GeneratorCommand::Next(value))
                    }));
                    return generator_finish_resume(generator, outcome);
                }
            },
            GeneratorState::Suspended => {
                data.state = GeneratorState::Executing;
                data.continuation
                    .take()
                    .expect("scriptc: suspended generator without continuation")
            }
        }
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        continuation(generator.clone(), command)
    }));
    generator_finish_resume(generator, outcome)
}

fn generator_finish_resume<Y, R, N>(
    generator: &JsGenerator<Y, R, N>,
    outcome: std::thread::Result<GeneratorStep<Y, R>>,
) -> GeneratorStep<Y, R> {
    match outcome {
        Ok(step) => {
            let mut data = generator.0.borrow_mut();
            match &step {
                GeneratorStep::Yielded(_) => {
                    assert_eq!(data.state, GeneratorState::Suspended);
                    assert!(data.continuation.is_some());
                }
                GeneratorStep::Returned(_) => {
                    data.state = GeneratorState::Done;
                    data.continuation = None;
                    data.panic_handlers.clear();
                }
            }
            step
        }
        Err(payload) => {
            let handler = {
                let mut data = generator.0.borrow_mut();
                data.state = GeneratorState::Done;
                data.continuation = None;
                data.panic_handlers.pop()
            };
            let Some(handler) = handler else {
                std::panic::resume_unwind(payload);
            };
            let reason = caught_from_panic(payload);
            generator.0.borrow_mut().state = GeneratorState::Executing;
            let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handler(generator.clone(), reason)
            }));
            generator_finish_resume(generator, handled)
        }
    }
}

pub fn generator_next<Y, R, N>(generator: &JsGenerator<Y, R, N>, value: N) -> GeneratorStep<Y, R> {
    generator_resume(generator, GeneratorCommand::Next(value))
}

pub fn generator_return<Y, R, N>(
    generator: &JsGenerator<Y, R, N>,
    value: Option<R>,
) -> GeneratorStep<Y, R> {
    generator_resume(generator, GeneratorCommand::Return(value))
}

pub fn generator_throw<Y, R, N>(
    generator: &JsGenerator<Y, R, N>,
    reason: Caught,
) -> GeneratorStep<Y, R> {
    generator_resume(generator, GeneratorCommand::Throw(reason))
}

pub fn generator_ptr_eq<Y, R, N>(
    left: &JsGenerator<Y, R, N>,
    right: &JsGenerator<Y, R, N>,
) -> bool {
    Rc::ptr_eq(&left.0, &right.0)
}

/// What one async-generator body step hands its driver: a yielded value that settles
/// the pending request, or an await the driver subscribes to before resuming the body
/// with the settled outcome.
pub enum AsyncGeneratorYield<Y> {
    Value(Y),
    Await(AsyncGeneratorAwait),
}

/// The type-erased resume value of an async-generator body: a `.next(value)` argument
/// or an awaited result. Resume sites recover the static type with a checked downcast.
pub type AsyncGeneratorInput = Box<dyn Any>;
pub type AsyncGeneratorAwait =
    Box<dyn FnOnce(Box<dyn FnOnce(Result<AsyncGeneratorInput, Caught>)>)>;
type AsyncGeneratorBody<Y, R> = JsGenerator<AsyncGeneratorYield<Y>, R, AsyncGeneratorInput>;

#[derive(Clone)]
pub enum AsyncGeneratorStep<Y, R> {
    Yielded(Y),
    Returned(Option<R>),
}

impl<Y: Clone + 'static, R: Clone + 'static> HeapValue for AsyncGeneratorStep<Y, R> {}

enum AsyncGeneratorRequest<N, R> {
    Next(N),
    Return(Option<R>),
    Throw(Caught),
}

type AsyncGeneratorQueue<Y, R, N> =
    VecDeque<(AsyncGeneratorRequest<N, R>, JsPromise<AsyncGeneratorStep<Y, R>>)>;

struct AsyncGeneratorData<Y, R, N>
where
    Y: Clone + 'static,
    R: Clone + 'static,
{
    body: AsyncGeneratorBody<Y, R>,
    queue: AsyncGeneratorQueue<Y, R, N>,
    running: bool,
    done: bool,
}

/// Safe JavaScript async generator: requests queue in call order, each answers a
/// promise, and the body runs one request at a time over the synchronous generator
/// protocol, parking on awaits without a native stack.
pub struct JsAsyncGenerator<Y, R, N>(Rc<RefCell<AsyncGeneratorData<Y, R, N>>>)
where
    Y: Clone + 'static,
    R: Clone + 'static;

impl<Y: Clone + 'static, R: Clone + 'static, N> Clone for JsAsyncGenerator<Y, R, N> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<Y, R, N> HeapValue for JsAsyncGenerator<Y, R, N>
where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: Clone + 'static,
{
}

pub fn async_generator_new<Y, R, N, F>(start: F) -> JsAsyncGenerator<Y, R, N>
where
    Y: Clone + 'static,
    R: Clone + 'static,
    F: FnOnce(
            AsyncGeneratorBody<Y, R>,
            GeneratorCommand<AsyncGeneratorInput, R>,
        ) -> GeneratorStep<AsyncGeneratorYield<Y>, R>
        + 'static,
{
    JsAsyncGenerator(Rc::new(RefCell::new(AsyncGeneratorData {
        body: generator_new(start),
        queue: VecDeque::new(),
        running: false,
        done: false,
    })))
}

pub fn async_generator_await<Y, T: HeapValue>(promise: JsPromise<T>) -> AsyncGeneratorYield<Y> {
    AsyncGeneratorYield::Await(Box::new(move |resume| {
        promise_then(
            &promise,
            Box::new(move |outcome| resume(outcome.map(|value| Box::new(value) as AsyncGeneratorInput))),
        );
    }))
}

pub fn async_generator_input<T: 'static>(input: AsyncGeneratorInput) -> T {
    match input.downcast::<T>() {
        Ok(value) => *value,
        Err(_) => panic!("scriptc invariant: async generator resumed with a mistyped value"),
    }
}

pub fn async_generator_next<Y, R, N>(
    generator: &JsAsyncGenerator<Y, R, N>,
    value: N,
) -> JsPromise<AsyncGeneratorStep<Y, R>>
where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: 'static,
{
    async_generator_enqueue(generator, AsyncGeneratorRequest::Next(value))
}

pub fn async_generator_return<Y, R, N>(
    generator: &JsAsyncGenerator<Y, R, N>,
    value: Option<R>,
) -> JsPromise<AsyncGeneratorStep<Y, R>>
where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: 'static,
{
    async_generator_enqueue(generator, AsyncGeneratorRequest::Return(value))
}

pub fn async_generator_throw<Y, R, N>(
    generator: &JsAsyncGenerator<Y, R, N>,
    reason: Caught,
) -> JsPromise<AsyncGeneratorStep<Y, R>>
where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: 'static,
{
    async_generator_enqueue(generator, AsyncGeneratorRequest::Throw(reason))
}

pub fn async_generator_ptr_eq<Y: Clone + 'static, R: Clone + 'static, N>(
    left: &JsAsyncGenerator<Y, R, N>,
    right: &JsAsyncGenerator<Y, R, N>,
) -> bool {
    Rc::ptr_eq(&left.0, &right.0)
}

fn async_generator_enqueue<Y, R, N>(
    generator: &JsAsyncGenerator<Y, R, N>,
    request: AsyncGeneratorRequest<N, R>,
) -> JsPromise<AsyncGeneratorStep<Y, R>>
where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: 'static,
{
    let promise = promise_new();
    generator.0.borrow_mut().queue.push_back((request, promise.clone()));
    async_generator_drain(generator);
    promise
}

/// Run queued requests until the body parks on an await or the queue empties. A
/// completed generator answers `next` and `return` with done results and rejects
/// `throw` with its reason, without running the body again.
fn async_generator_drain<Y, R, N>(generator: &JsAsyncGenerator<Y, R, N>)
where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: 'static,
{
    loop {
        let (request, promise, done) = {
            let mut data = generator.0.borrow_mut();
            if data.running {
                return;
            }
            let Some((request, promise)) = data.queue.pop_front() else {
                return;
            };
            let done = data.done;
            if !done {
                data.running = true;
            }
            (request, promise, done)
        };
        if done {
            match request {
                AsyncGeneratorRequest::Next(_) => {
                    let _ = promise_fulfill(&promise, AsyncGeneratorStep::Returned(None));
                }
                AsyncGeneratorRequest::Return(value) => {
                    let _ = promise_fulfill(&promise, AsyncGeneratorStep::Returned(value));
                }
                AsyncGeneratorRequest::Throw(reason) => {
                    let _ = promise_reject(&promise, reason);
                }
            }
            continue;
        }
        let command = match request {
            AsyncGeneratorRequest::Next(value) => {
                GeneratorCommand::Next(Box::new(value) as AsyncGeneratorInput)
            }
            AsyncGeneratorRequest::Return(value) => GeneratorCommand::Return(value),
            AsyncGeneratorRequest::Throw(reason) => GeneratorCommand::Throw(reason),
        };
        async_generator_resume(generator, command, promise);
    }
}

fn async_generator_resume<Y, R, N>(
    generator: &JsAsyncGenerator<Y, R, N>,
    command: GeneratorCommand<AsyncGeneratorInput, R>,
    promise: JsPromise<AsyncGeneratorStep<Y, R>>,
) where
    Y: Clone + 'static,
    R: Clone + 'static,
    N: 'static,
{
    let body = generator.0.borrow().body.clone();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match command {
        GeneratorCommand::Next(value) => generator_next(&body, value),
        GeneratorCommand::Return(value) => generator_return(&body, value),
        GeneratorCommand::Throw(reason) => generator_throw(&body, reason),
    }));
    let finished = match outcome {
        Ok(GeneratorStep::Yielded(AsyncGeneratorYield::Await(subscribe))) => {
            let parked = generator.clone();
            subscribe(Box::new(move |outcome| {
                let command = match outcome {
                    Ok(value) => GeneratorCommand::Next(value),
                    Err(reason) => GeneratorCommand::Throw(reason),
                };
                async_generator_resume(&parked, command, promise);
                async_generator_drain(&parked);
            }));
            return;
        }
        Ok(GeneratorStep::Yielded(AsyncGeneratorYield::Value(value))) => {
            let _ = promise_fulfill(&promise, AsyncGeneratorStep::Yielded(value));
            false
        }
        Ok(GeneratorStep::Returned(value)) => {
            let _ = promise_fulfill(&promise, AsyncGeneratorStep::Returned(value));
            true
        }
        Err(payload) => {
            let _ = promise_reject(&promise, caught_from_panic(payload));
            true
        }
    };
    let mut data = generator.0.borrow_mut();
    data.running = false;
    if finished {
        data.done = true;
    }
}
