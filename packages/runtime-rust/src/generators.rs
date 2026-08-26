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

struct GeneratorData<Y, R, N> {
    state: GeneratorState,
    continuation: Option<GeneratorContinuation<Y, R, N>>,
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
    })))
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
                    return GeneratorStep::Returned(value);
                }
                GeneratorCommand::Throw(reason) => {
                    data.state = GeneratorState::Done;
                    data.continuation = None;
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
                }
            }
            step
        }
        Err(payload) => {
            let mut data = generator.0.borrow_mut();
            data.state = GeneratorState::Done;
            data.continuation = None;
            drop(data);
            std::panic::resume_unwind(payload)
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
