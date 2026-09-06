/* The effect kernel: the native runtime behind `import { Effect } from
 * "effect"` in static builds (frontend/lowering/lower-effect.ts).
 *
 * An `Effect<A, E, R>` is a DESCRIPTION — a tree of nodes built by the
 * combinators and run by `effect_run_*`. Values cross the kernel as
 * `EffectValue` (an `Rc<dyn Any>`): generated code boxes what it knows
 * the type of and unboxes with the same type on the way out, so the
 * kernel stays monomorphic while the program keeps its native
 * representations. `Effect.gen` bodies are the runtime's own generators
 * (fibers): the kernel resumes them with each yielded effect's value.
 * This slice is synchronous: succeed/sync/fail/die, map/flatMap,
 * catchAll/mapError/orDie, gen, and the two runners. */

/// A boxed program value in transit through the kernel.
pub type EffectValue = Rc<dyn Any>;

pub fn effect_box<T: 'static>(value: T) -> EffectValue {
    Rc::new(value)
}

/// The typed value back out: the site's type is the checker's, so a
/// mismatch is a compiler bug, not a program error.
pub fn effect_unbox<T: Clone + 'static>(value: &EffectValue) -> T {
    value
        .downcast_ref::<T>()
        .unwrap_or_else(|| panic!("scriptc: effect value is not a {}", std::any::type_name::<T>()))
        .clone()
}

type TraceFn = Box<dyn Fn(&mut Tracer<'_>)>;
type ValueFn = Rc<dyn Fn(EffectValue) -> EffectValue>;
type EffectFn = Rc<dyn Fn(EffectValue) -> JsEffect>;

/// One step of an `Effect.gen` body as the kernel drives it.
pub enum EffectStep {
    Yielded(JsEffect),
    Returned(EffectValue),
}

/// A generator body with its return type erased (the kernel resumes it
/// with the yielded effect's value, as a succeeded effect).
pub trait EffectGen {
    fn resume(&self, value: JsEffect) -> EffectStep;
}

struct TypedGen<R>(JsGenerator<JsEffect, R, JsEffect>);

impl<R: Clone + 'static> EffectGen for TypedGen<R> {
    fn resume(&self, value: JsEffect) -> EffectStep {
        match generator_next(&self.0, value) {
            GeneratorStep::Yielded(effect) => EffectStep::Yielded(effect),
            GeneratorStep::Returned(Some(result)) => EffectStep::Returned(Rc::new(result)),
            GeneratorStep::Returned(None) => EffectStep::Returned(Rc::new(())),
        }
    }
}

type GenFn = Rc<dyn Fn() -> Box<dyn EffectGen>>;
type PromiseFn = Rc<dyn Fn() -> JsPromiseHandle>;
type RecoverFn = Rc<dyn Fn(Caught) -> EffectValue>;

enum EffectNode {
    Succeed(EffectValue),
    Fail(EffectValue),
    Die(EffectValue),
    Sync(Rc<dyn Fn() -> EffectValue>, TraceFn),
    Map(JsEffect, ValueFn, TraceFn),
    FlatMap(JsEffect, EffectFn, TraceFn),
    CatchAll(JsEffect, EffectFn, TraceFn),
    MapError(JsEffect, ValueFn, TraceFn),
    OrDie(JsEffect),
    Gen(GenFn, TraceFn),
    /// `Effect.promise`: a rejection is a defect.
    Promise(PromiseFn, TraceFn),
    /// `Effect.tryPromise`: a rejection becomes the failure `recover` answers.
    TryPromise(PromiseFn, RecoverFn, TraceFn),
}

pub struct EffectData {
    node: EffectNode,
}

impl Trace for EffectData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        match &self.node {
            EffectNode::Succeed(_) | EffectNode::Fail(_) | EffectNode::Die(_) => {}
            EffectNode::Sync(_, trace) | EffectNode::Gen(_, trace) | EffectNode::Promise(_, trace) | EffectNode::TryPromise(_, _, trace) => trace(tracer),
            EffectNode::OrDie(inner) => tracer.edge(inner),
            EffectNode::Map(inner, _, trace)
            | EffectNode::FlatMap(inner, _, trace)
            | EffectNode::CatchAll(inner, _, trace)
            | EffectNode::MapError(inner, _, trace) => {
                tracer.edge(inner);
                trace(tracer);
            }
        }
    }
}

impl ClearEdges for EffectData {
    fn clear_edges(&mut self) {
        self.node = EffectNode::Succeed(Rc::new(()));
    }
}

pub type JsEffect = Gc<EffectData>;

fn effect_new(node: EffectNode) -> JsEffect {
    Gc::new(EffectData { node })
}

pub fn effect_succeed(value: EffectValue) -> JsEffect {
    effect_new(EffectNode::Succeed(value))
}

pub fn effect_fail(error: EffectValue) -> JsEffect {
    effect_new(EffectNode::Fail(error))
}

pub fn effect_die(defect: EffectValue) -> JsEffect {
    effect_new(EffectNode::Die(defect))
}

pub fn effect_sync(thunk: Rc<dyn Fn() -> EffectValue>, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Sync(thunk, trace))
}

pub fn effect_map(source: &JsEffect, f: ValueFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Map(source.clone(), f, trace))
}

pub fn effect_flat_map(source: &JsEffect, f: EffectFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::FlatMap(source.clone(), f, trace))
}

pub fn effect_catch_all(source: &JsEffect, f: EffectFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::CatchAll(source.clone(), f, trace))
}

pub fn effect_map_error(source: &JsEffect, f: ValueFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::MapError(source.clone(), f, trace))
}

pub fn effect_or_die(source: &JsEffect) -> JsEffect {
    effect_new(EffectNode::OrDie(source.clone()))
}

pub fn effect_promise(thunk: PromiseFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Promise(thunk, trace))
}

pub fn effect_try_promise(thunk: PromiseFn, recover: RecoverFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::TryPromise(thunk, recover, trace))
}

pub fn effect_gen<R: Clone + 'static>(make: Rc<dyn Fn() -> JsGenerator<JsEffect, R, JsEffect>>, trace: TraceFn) -> JsEffect {
    let erased: GenFn = Rc::new(move || Box::new(TypedGen(make())) as Box<dyn EffectGen>);
    effect_new(EffectNode::Gen(erased, trace))
}

/// A frame of the fiber's continuation stack: what to do with the
/// inner effect's outcome.
enum Frame {
    Map(ValueFn),
    FlatMap(EffectFn),
    CatchAll(EffectFn),
    MapError(ValueFn),
    OrDie,
    Gen(Box<dyn EffectGen>),
}

type Outcome = Result<EffectValue, EffectValue>;

enum Step {
    Done(Outcome),
    Push(Frame, JsEffect),
    Resume(Box<dyn EffectGen>),
    /// Suspend on a promise; `recover` (tryPromise) turns a rejection into
    /// a failure, its absence (promise) makes the rejection a defect.
    Await(JsPromiseHandle, Option<RecoverFn>),
}

/// A defect (`Effect.die`, `orDie` over a failure, a rejected
/// `Effect.promise`) leaves the kernel as an ordinary scriptc throw.
fn effect_defect(defect: EffectValue) -> ! {
    let message = defect
        .downcast_ref::<JsString>()
        .map(|text| text.to_string())
        .or_else(|| defect.downcast_ref::<f64>().map(|n| number_to_string(*n).to_string()))
        .unwrap_or_else(|| "Effect defect".to_owned());
    throw_error(message)
}

/// One running effect: the node being evaluated (or the outcome a
/// promise delivered), the continuation stack, and where the exit goes.
/// It lives in an `Rc` so a promise reaction can resume it.
pub struct EffectFiber {
    current: Option<JsEffect>,
    resumed: Option<Outcome>,
    frames: Vec<Frame>,
    on_exit: Option<Box<dyn FnOnce(Outcome)>>,
}

type FiberRef = Rc<RefCell<EffectFiber>>;

fn fiber_new(effect: &JsEffect, on_exit: Box<dyn FnOnce(Outcome)>) -> FiberRef {
    Rc::new(RefCell::new(EffectFiber { current: Some(effect.clone()), resumed: None, frames: Vec::new(), on_exit: Some(on_exit) }))
}

fn effect_step(effect: &JsEffect) -> Step {
    effect.with(|data| match &data.node {
        EffectNode::Succeed(value) => Step::Done(Ok(value.clone())),
        EffectNode::Fail(error) => Step::Done(Err(error.clone())),
        EffectNode::Die(defect) => effect_defect(defect.clone()),
        EffectNode::Sync(thunk, _) => Step::Done(Ok(thunk())),
        EffectNode::Map(inner, f, _) => Step::Push(Frame::Map(f.clone()), inner.clone()),
        EffectNode::FlatMap(inner, f, _) => Step::Push(Frame::FlatMap(f.clone()), inner.clone()),
        EffectNode::CatchAll(inner, f, _) => Step::Push(Frame::CatchAll(f.clone()), inner.clone()),
        EffectNode::MapError(inner, f, _) => Step::Push(Frame::MapError(f.clone()), inner.clone()),
        EffectNode::OrDie(inner) => Step::Push(Frame::OrDie, inner.clone()),
        EffectNode::Gen(make, _) => Step::Resume(make()),
        EffectNode::Promise(thunk, _) => Step::Await(thunk(), None),
        EffectNode::TryPromise(thunk, recover, _) => Step::Await(thunk(), Some(recover.clone())),
    })
}

/// Drive a fiber until it exits or suspends on a promise (which resumes
/// it from the promise's reaction, on a later loop turn).
fn fiber_drive(fiber: &FiberRef) {
    loop {
        let (current, resumed) = {
            let mut state = fiber.borrow_mut();
            (state.current.take(), state.resumed.take())
        };
        let mut outcome: Option<Outcome> = Some(match (current, resumed) {
            (_, Some(outcome)) => outcome,
            (Some(effect), None) => match effect_step(&effect) {
                Step::Push(frame, inner) => {
                    let mut state = fiber.borrow_mut();
                    state.frames.push(frame);
                    state.current = Some(inner);
                    continue;
                }
                Step::Done(outcome) => outcome,
                // A fresh generator: the first resume's value is ignored (JS semantics).
                Step::Resume(generator) => match generator.resume(effect_succeed(Rc::new(()))) {
                    EffectStep::Yielded(next) => {
                        let mut state = fiber.borrow_mut();
                        state.frames.push(Frame::Gen(generator));
                        state.current = Some(next);
                        continue;
                    }
                    EffectStep::Returned(value) => Ok(value),
                },
                Step::Await(handle, recover) => {
                    let resumed = fiber.clone();
                    promise_handle_observe(
                        &handle,
                        Box::new(move |settled| {
                            let outcome = match settled {
                                Ok(value) => Ok(Rc::from(value) as EffectValue),
                                Err(reason) => match &recover {
                                    Some(recover) => Err(recover(reason)),
                                    None => effect_defect(Rc::new(caught_to_string(&reason))),
                                },
                            };
                            resumed.borrow_mut().resumed = Some(outcome);
                            fiber_drive(&resumed);
                        }),
                    );
                    return;
                }
            },
            (None, None) => return,
        });
        loop {
            let frame = fiber.borrow_mut().frames.pop();
            let taken = outcome.take().expect("scriptc: effect fiber without an outcome");
            let Some(frame) = frame else {
                let on_exit = fiber.borrow_mut().on_exit.take();
                if let Some(on_exit) = on_exit {
                    on_exit(taken);
                }
                return;
            };
            let next: Option<JsEffect> = match (frame, taken) {
                (Frame::Map(f), Ok(value)) => {
                    outcome = Some(Ok(f(value)));
                    None
                }
                (Frame::FlatMap(f), Ok(value)) => Some(f(value)),
                (Frame::CatchAll(f), Err(error)) => Some(f(error)),
                (Frame::MapError(f), Err(error)) => {
                    outcome = Some(Err(f(error)));
                    None
                }
                (Frame::OrDie, Err(error)) => effect_defect(error),
                (Frame::Gen(generator), Ok(value)) => match generator.resume(effect_succeed(value)) {
                    EffectStep::Yielded(next) => {
                        fiber.borrow_mut().frames.push(Frame::Gen(generator));
                        Some(next)
                    }
                    EffectStep::Returned(result) => {
                        outcome = Some(Ok(result));
                        None
                    }
                },
                // A failure abandons the generator (Effect never resumes a body past a failed yield*).
                (Frame::Gen(_), Err(error)) => {
                    outcome = Some(Err(error));
                    None
                }
                (_, passthrough) => {
                    outcome = Some(passthrough);
                    None
                }
            };
            if let Some(next) = next {
                fiber.borrow_mut().current = Some(next);
                break;
            }
        }
    }
}

/// `Effect.runSync`: the value; a failure throws; an asynchronous
/// boundary is Effect's own refusal.
pub fn effect_run_sync(effect: &JsEffect) -> EffectValue {
    let exit: Rc<RefCell<Option<Outcome>>> = Rc::new(RefCell::new(None));
    let slot = exit.clone();
    let fiber = fiber_new(effect, Box::new(move |outcome| *slot.borrow_mut() = Some(outcome)));
    fiber_drive(&fiber);
    let outcome = exit.borrow_mut().take();
    match outcome {
        Some(Ok(value)) => value,
        Some(Err(error)) => effect_defect(error),
        None => throw_error("Fiber cannot be resolved synchronously. This is caused by using runSync on an effect that performs an asynchronous operation".to_owned()),
    }
}

/// `Effect.runPromise`: a promise of the site's type, settled by the fiber's exit.
pub fn effect_run_promise<T: HeapValue>(effect: &JsEffect) -> JsPromise<T> {
    let promise = promise_new::<T>();
    let target = promise.clone();
    let fiber = fiber_new(
        effect,
        Box::new(move |outcome| match outcome {
            Ok(value) => {
                let _ = promise_fulfill(&target, effect_unbox::<T>(&value));
            }
            Err(error) => {
                let _ = promise_reject(&target, caught_from_any(error));
            }
        }),
    );
    fiber_drive(&fiber);
    promise
}
