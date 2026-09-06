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
}

pub struct EffectData {
    node: EffectNode,
}

impl Trace for EffectData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        match &self.node {
            EffectNode::Succeed(_) | EffectNode::Fail(_) | EffectNode::Die(_) => {}
            EffectNode::Sync(_, trace) | EffectNode::Gen(_, trace) => trace(tracer),
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

pub fn effect_gen<R: Clone + 'static>(make: Rc<dyn Fn() -> JsGenerator<JsEffect, R, JsEffect>>, trace: TraceFn) -> JsEffect {
    let erased: GenFn = Rc::new(move || Box::new(TypedGen(make())) as Box<dyn EffectGen>);
    effect_new(EffectNode::Gen(erased, trace))
}

/// A frame of the interpreter's continuation stack: what to do with the
/// inner effect's outcome.
enum Frame {
    Map(ValueFn),
    FlatMap(EffectFn),
    CatchAll(EffectFn),
    MapError(ValueFn),
    OrDie,
    Gen(Box<dyn EffectGen>),
}

enum Step {
    Done(Result<EffectValue, EffectValue>),
    Push(Frame, JsEffect),
    Resume(Box<dyn EffectGen>),
}

/// A defect (`Effect.die`, `orDie` over a failure) leaves the kernel as
/// an ordinary scriptc throw.
fn effect_defect(defect: EffectValue) -> ! {
    let message = defect
        .downcast_ref::<JsString>()
        .map(|text| text.to_string())
        .or_else(|| defect.downcast_ref::<f64>().map(|n| number_to_string(*n).to_string()))
        .unwrap_or_else(|| "Effect defect".to_owned());
    throw_error(message)
}

/// Run a description on the current thread to its exit: the value, or
/// the failure channel's value.
pub fn effect_run(effect: &JsEffect) -> Result<EffectValue, EffectValue> {
    let mut current = effect.clone();
    let mut frames: Vec<Frame> = Vec::new();
    loop {
        let step = current.with(|data| match &data.node {
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
        });
        let mut outcome = match step {
            Step::Push(frame, inner) => {
                frames.push(frame);
                current = inner;
                continue;
            }
            Step::Done(outcome) => outcome,
            // A fresh generator: the first resume's value is ignored (JS semantics).
            Step::Resume(generator) => match generator.resume(effect_succeed(Rc::new(()))) {
                EffectStep::Yielded(next) => {
                    frames.push(Frame::Gen(generator));
                    current = next;
                    continue;
                }
                EffectStep::Returned(value) => Ok(value),
            },
        };
        loop {
            let Some(frame) = frames.pop() else { return outcome };
            match (frame, outcome) {
                (Frame::Map(f), Ok(value)) => outcome = Ok(f(value)),
                (Frame::FlatMap(f), Ok(value)) => {
                    current = f(value);
                    break;
                }
                (Frame::CatchAll(f), Err(error)) => {
                    current = f(error);
                    break;
                }
                (Frame::MapError(f), Err(error)) => outcome = Err(f(error)),
                (Frame::OrDie, Err(error)) => effect_defect(error),
                (Frame::Gen(generator), Ok(value)) => match generator.resume(effect_succeed(value)) {
                    EffectStep::Yielded(next) => {
                        frames.push(Frame::Gen(generator));
                        current = next;
                        break;
                    }
                    EffectStep::Returned(result) => outcome = Ok(result),
                },
                // A failure abandons the generator (Effect never resumes a body past a failed yield*).
                (Frame::Gen(_), Err(error)) => outcome = Err(error),
                (_, passthrough) => outcome = passthrough,
            }
        }
    }
}

/// `Effect.runSync`: the value, or the failure as a throw (the fiber
/// failure's message shape is the next slice's).
pub fn effect_run_sync(effect: &JsEffect) -> EffectValue {
    match effect_run(effect) {
        Ok(value) => value,
        Err(error) => effect_defect(error),
    }
}

/// `Effect.runPromise`: the value as a settled promise of the site's type.
pub fn effect_run_promise<T: HeapValue>(effect: &JsEffect) -> JsPromise<T> {
    promise_resolved(effect_unbox::<T>(&effect_run_sync(effect)))
}
