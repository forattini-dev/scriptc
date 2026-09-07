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
        .unwrap_or_else(|| effect_unbox_mismatch(std::any::type_name::<T>()))
        .clone()
}

/// A union site found neither the union nor any of its arms in the box (the emitter's arm-wise unbox).
pub fn effect_unbox_mismatch(expected: &str) -> ! {
    panic!("scriptc: effect value is not a {expected}")
}

/// The unit arms of a union, boxed distinguishably (`undefined` vs `null`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EffectUnit {
    Undefined,
    Null,
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
type ItemFn = Rc<dyn Fn(EffectValue, f64) -> JsEffect>;
/// A finalizer: the scope's exit (as a data handle) → the effect to run.
type FinalizerFn = Rc<dyn Fn(JsEffect) -> JsEffect>;
/// `acquireRelease`'s release: the resource and the exit → the effect to run.
type ReleaseFn = Rc<dyn Fn(EffectValue, JsEffect) -> JsEffect>;
/// Rebuilds the program's typed collection from the kernel's boxed values (the emitter's carrier).
type CollectFn = Rc<dyn Fn(Vec<EffectValue>) -> EffectValue>;
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
    /// `Effect.as`/`asVoid`: the inner value replaced; `ignore`: any exit becomes unit; `andThen(e, next)`: next after e.
    As(JsEffect, EffectValue),
    Ignore(JsEffect),
    ZipRight(JsEffect, JsEffect),
    Gen(GenFn, TraceFn),
    /// A service key: run, it looks the service up in the fiber's environment (`yield* Service`).
    ServiceKey(Rc<str>),
    /// `Effect.provideService` / a built layer's bundle provided to the inner effect.
    ProvideBundle(JsEffect, Bundle),
    /// `Effect.provide(e, layer)`: the layer builds (an effect answering its bundle), then provides.
    ProvideLayer(JsEffect, JsEffect),
    /// A layer description (`Layer<…>` values share the handle).
    Layer(LayerNode),
    /// `Effect.forEach(items, f)` / `Effect.all(effects)`: sequential, collected by the carrier's closure.
    ForEach(Vec<EffectValue>, ItemFn, CollectFn, TraceFn),
    All(JsArray<JsEffect>, CollectFn),
    /// The default logger's line: level and the message parts.
    Log(JsString, JsArray<JsString>),
    Tap(JsEffect, EffectFn, TraceFn),
    TapError(JsEffect, EffectFn, TraceFn),
    Suspend(Rc<dyn Fn() -> JsEffect>, TraceFn),
    Sleep(f64),
    Scoped(JsEffect),
    AddFinalizer(FinalizerFn, TraceFn),
    Ensuring(JsEffect, JsEffect),
    AcquireRelease(JsEffect, ReleaseFn, TraceFn),
    AcquireUseRelease(JsEffect, EffectFn, ReleaseFn, TraceFn),
    /// `Effect.exit`: the inner effect's exit as a data handle.
    Exit(JsEffect),
    /// Kernel DATA riding the handle: an Exit or an Option.
    Data(KernelData),
    /// `Effect.try({ try, catch })`: the thunk's throw becomes the failure `recover` answers.
    Try(Rc<dyn Fn() -> EffectValue>, RecoverFn, TraceFn),
    OrElseSucceed(JsEffect, Rc<dyn Fn() -> EffectValue>, TraceFn),
    CatchIf(JsEffect, Rc<dyn Fn(EffectValue) -> bool>, EffectFn, TraceFn),
    /// `Effect.promise`: a rejection is a defect.
    Promise(PromiseFn, TraceFn),
    /// `Effect.tryPromise`: a rejection becomes the failure `recover` answers.
    TryPromise(PromiseFn, RecoverFn, TraceFn),
    /// `Deferred.await(d)` / a semaphore permit: park until the latch answers.
    Park(Rc<RefCell<Latch>>),
    /// A queue operation that may park: `None` takes, `Some(value)` offers.
    Queue(Rc<RefCell<QueueState>>, Option<EffectValue>),
}

/// The services a layer answers / a provide installs: `(key, value)` pairs, later entries shadowing earlier ones.
pub type Bundle = Rc<Vec<(Rc<str>, EffectValue)>>;

#[derive(Clone)]
pub enum LayerNode {
    Empty,
    Succeed(Rc<str>, EffectValue),
    Effect(Rc<str>, JsEffect),
    /// `Layer.effectDiscard(effect)`: runs the effect for its effects, provides nothing.
    EffectDiscard(JsEffect),
    /// `Layer.provide(outer, inner)`: inner's services feed outer's build and stay hidden; `provideMerge` keeps them.
    Provide(JsEffect, JsEffect, bool),
    Merge(JsEffect, JsEffect),
}

#[derive(Clone)]
pub enum KernelData {
    Exit(Outcome),
    Option(Option<EffectValue>),
    /// A Schema descriptor (schema.rs).
    Schema(Rc<SchemaNode>),
    /// A failed decode's SchemaError: the issue text.
    SchemaError(JsString),
    /// A Duration, in milliseconds (effect's nanosecond precision is not observable here).
    Duration(f64),
    /// A `Ref`/`SynchronizedRef` cell. The runtime is single-threaded and fibers hand off only at suspension
    /// points, so a synchronized ref is the same cell — the "synchronized" part is about effectful updates
    /// running one at a time, which sequential execution already gives.
    Ref(Rc<RefCell<EffectValue>>),
    /// A `Deferred` (settled once, every awaiting fiber resumes) or a `Semaphore` (a permit count with the same
    /// waiter queue). Both are the kernel's Latch.
    Deferred(Rc<RefCell<Latch>>),
    Semaphore(Rc<RefCell<Latch>>),
    /// A `Queue` (and the per-subscriber queue a `PubSub` hands out): items with waiting takers and offerers.
    Queue(Rc<RefCell<QueueState>>),
    /// The failure `Effect.tryPromise(thunk)` builds from a rejection: effect's `UnknownError`, whose message is
    /// fixed ("An error occurred in Effect.tryPromise" — the reason itself rides effect's `cause`, which the kernel
    /// does not model yet).
    Unknown(JsString),
    /// A `PubSub`: the subscriber queues a publish broadcasts into.
    PubSub(Rc<RefCell<PubSubState>>),
}

pub struct EffectData {
    node: EffectNode,
}

impl Trace for EffectData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        match &self.node {
            EffectNode::Succeed(_) | EffectNode::Fail(_) | EffectNode::Die(_) | EffectNode::ServiceKey(_) => {}
            EffectNode::ProvideBundle(inner, _) => tracer.edge(inner),
            EffectNode::ForEach(_, _, _, trace) => trace(tracer),
            EffectNode::All(effects, _) => tracer.edge(effects),
            EffectNode::Log(_, parts) => tracer.edge(parts),
            EffectNode::Sleep(_) | EffectNode::Data(_) | EffectNode::Park(_) | EffectNode::Queue(_, _) => {}
            EffectNode::Scoped(inner) | EffectNode::Exit(inner) => tracer.edge(inner),
            EffectNode::Tap(inner, _, trace) | EffectNode::TapError(inner, _, trace) | EffectNode::AcquireRelease(inner, _, trace) | EffectNode::AcquireUseRelease(inner, _, _, trace) => {
                tracer.edge(inner);
                trace(tracer);
            }
            EffectNode::Suspend(_, trace) | EffectNode::AddFinalizer(_, trace) | EffectNode::Try(_, _, trace) => trace(tracer),
            EffectNode::OrElseSucceed(inner, _, trace) | EffectNode::CatchIf(inner, _, _, trace) => {
                tracer.edge(inner);
                trace(tracer);
            }
            EffectNode::Ensuring(inner, finalizer) => {
                tracer.edge(inner);
                tracer.edge(finalizer);
            }
            EffectNode::ProvideLayer(inner, layer) => {
                tracer.edge(inner);
                tracer.edge(layer);
            }
            EffectNode::Layer(layer) => match layer {
                LayerNode::Empty | LayerNode::Succeed(..) => {}
                LayerNode::Effect(_, effect) | LayerNode::EffectDiscard(effect) => tracer.edge(effect),
                LayerNode::Provide(a, b, _) | LayerNode::Merge(a, b) => {
                    tracer.edge(a);
                    tracer.edge(b);
                }
            },
            EffectNode::Sync(_, trace) | EffectNode::Gen(_, trace) | EffectNode::Promise(_, trace) | EffectNode::TryPromise(_, _, trace) => trace(tracer),
            EffectNode::OrDie(inner) | EffectNode::As(inner, _) | EffectNode::Ignore(inner) => tracer.edge(inner),
            EffectNode::ZipRight(inner, next) => {
                tracer.edge(inner);
                tracer.edge(next);
            }
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

pub fn effect_as(source: &JsEffect, value: EffectValue) -> JsEffect {
    effect_new(EffectNode::As(source.clone(), value))
}

pub fn effect_ignore(source: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Ignore(source.clone()))
}

pub fn effect_zip_right(source: &JsEffect, next: &JsEffect) -> JsEffect {
    effect_new(EffectNode::ZipRight(source.clone(), next.clone()))
}

pub fn effect_promise(thunk: PromiseFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Promise(thunk, trace))
}

pub fn effect_try_promise(thunk: PromiseFn, recover: RecoverFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::TryPromise(thunk, recover, trace))
}

fn key_of(handle: &JsEffect) -> Rc<str> {
    handle.with(|data| match &data.node {
        EffectNode::ServiceKey(key) => key.clone(),
        _ => throw_error("scriptc: a service key was expected".to_owned()),
    })
}

pub fn effect_service_key(id: &JsString) -> JsEffect {
    effect_new(EffectNode::ServiceKey(Rc::from(id.as_ref())))
}

pub fn effect_provide_service(source: &JsEffect, key: &JsEffect, value: EffectValue) -> JsEffect {
    effect_new(EffectNode::ProvideBundle(source.clone(), Rc::new(vec![(key_of(key), value)])))
}

pub fn effect_provide(source: &JsEffect, layer: &JsEffect) -> JsEffect {
    effect_new(EffectNode::ProvideLayer(source.clone(), layer.clone()))
}

pub fn layer_empty() -> JsEffect {
    effect_new(EffectNode::Layer(LayerNode::Empty))
}

pub fn layer_succeed(key: &JsEffect, value: EffectValue) -> JsEffect {
    effect_new(EffectNode::Layer(LayerNode::Succeed(key_of(key), value)))
}

pub fn layer_effect(key: &JsEffect, effect: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Layer(LayerNode::Effect(key_of(key), effect.clone())))
}

pub fn layer_effect_discard(effect: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Layer(LayerNode::EffectDiscard(effect.clone())))
}

pub fn layer_provide(outer: &JsEffect, inner: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Layer(LayerNode::Provide(outer.clone(), inner.clone(), false)))
}

pub fn layer_provide_merge(outer: &JsEffect, inner: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Layer(LayerNode::Provide(outer.clone(), inner.clone(), true)))
}

pub fn layer_merge(left: &JsEffect, right: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Layer(LayerNode::Merge(left.clone(), right.clone())))
}

pub fn effect_for_each(items: Vec<EffectValue>, f: ItemFn, collect: CollectFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::ForEach(items, f, collect, trace))
}

pub fn effect_all(effects: &JsArray<JsEffect>, collect: CollectFn) -> JsEffect {
    effect_new(EffectNode::All(effects.clone(), collect))
}

pub fn effect_log(level: &JsString, parts: &JsArray<JsString>) -> JsEffect {
    effect_new(EffectNode::Log(level.clone(), parts.clone()))
}

pub fn effect_tap(source: &JsEffect, f: EffectFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Tap(source.clone(), f, trace))
}

pub fn effect_tap_error(source: &JsEffect, f: EffectFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::TapError(source.clone(), f, trace))
}

pub fn effect_suspend(thunk: Rc<dyn Fn() -> JsEffect>, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Suspend(thunk, trace))
}

pub fn effect_sleep(millis: f64) -> JsEffect {
    effect_new(EffectNode::Sleep(millis))
}

/// `Effect.sleep("2 seconds")`: Duration's text input — `<number> <unit>` with millis/seconds/minutes/hours/days.
pub fn effect_sleep_text(text: &JsString) -> JsEffect {
    let mut words = text.split_whitespace();
    let amount: f64 = words.next().and_then(|w| w.parse().ok()).unwrap_or(0.0);
    let unit = words.next().unwrap_or("millis");
    let scale = match unit.trim_end_matches('s') {
        "milli" | "millisecond" | "ms" => 1.0,
        "second" | "sec" => 1_000.0,
        "minute" | "min" => 60_000.0,
        "hour" | "hr" => 3_600_000.0,
        "day" => 86_400_000.0,
        _ => 1.0,
    };
    effect_new(EffectNode::Sleep(amount * scale))
}

pub fn effect_scoped(source: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Scoped(source.clone()))
}

pub fn effect_add_finalizer(finalizer: FinalizerFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::AddFinalizer(finalizer, trace))
}

pub fn effect_ensuring(source: &JsEffect, finalizer: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Ensuring(source.clone(), finalizer.clone()))
}

pub fn effect_acquire_release(acquire: &JsEffect, release: ReleaseFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::AcquireRelease(acquire.clone(), release, trace))
}

pub fn effect_acquire_use_release(acquire: &JsEffect, use_fn: EffectFn, release: ReleaseFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::AcquireUseRelease(acquire.clone(), use_fn, release, trace))
}

pub fn effect_exit(source: &JsEffect) -> JsEffect {
    effect_new(EffectNode::Exit(source.clone()))
}

fn exit_handle(outcome: Outcome) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Exit(outcome)))
}

pub fn effect_exit_succeed(value: EffectValue) -> JsEffect {
    exit_handle(Ok(value))
}

pub fn effect_exit_fail(error: EffectValue) -> JsEffect {
    exit_handle(Err(error))
}

pub fn effect_try(attempt: Rc<dyn Fn() -> EffectValue>, recover: RecoverFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Try(attempt, recover, trace))
}

pub fn effect_or_else_succeed(source: &JsEffect, or_else: Rc<dyn Fn() -> EffectValue>, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::OrElseSucceed(source.clone(), or_else, trace))
}

pub fn effect_catch_if(source: &JsEffect, predicate: Rc<dyn Fn(EffectValue) -> bool>, recover: EffectFn, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::CatchIf(source.clone(), predicate, recover, trace))
}

pub fn option_some(value: EffectValue) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Option(Some(value))))
}

pub fn option_none() -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Option(None)))
}

pub fn option_get(handle: &JsEffect) -> Option<EffectValue> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Option(value)) => value.clone(),
        _ => throw_error("scriptc: an Option was expected".to_owned()),
    })
}

pub fn option_is_some(handle: &JsEffect) -> bool {
    option_get(handle).is_some()
}

fn exit_of(handle: &JsEffect) -> Outcome {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Exit(outcome)) => outcome.clone(),
        _ => throw_error("scriptc: an Exit was expected".to_owned()),
    })
}

pub fn effect_exit_is_success(handle: &JsEffect) -> bool {
    exit_of(handle).is_ok()
}

/// `_tag` of a kernel data handle: "Success"/"Failure" for an Exit, "Some"/"None" for an Option.
pub fn effect_duration_millis(millis: f64) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Duration(millis)))
}

pub fn effect_duration_to_millis(handle: &JsEffect) -> f64 {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Duration(millis)) => *millis,
        _ => throw_error("scriptc: a Duration handle was expected".to_owned()),
    })
}

pub fn effect_data_tag(handle: &JsEffect) -> JsString {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Exit(outcome)) => string(if outcome.is_ok() { "Success" } else { "Failure" }),
        EffectNode::Data(KernelData::Option(value)) => string(if value.is_some() { "Some" } else { "None" }),
        EffectNode::Data(KernelData::SchemaError(_)) => string("SchemaError"),
        EffectNode::Data(KernelData::Unknown(_)) => string("UnknownError"),
        _ => throw_error("scriptc: a kernel data handle was expected".to_owned()),
    })
}

/// `.value` of a Success or a Some; the other arm has no value, which the checker's narrowing guards.
pub fn effect_exit_value(handle: &JsEffect) -> EffectValue {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Exit(Ok(value))) | EffectNode::Data(KernelData::Option(Some(value))) => value.clone(),
        _ => throw_error("value read on a Failure/None".to_owned()),
    })
}

thread_local! {
    static EFFECT_FIBER_IDS: Cell<u64> = const { Cell::new(0) };
}

/// The default logger's line: `[HH:MM:SS.mmm] LEVEL (#fiber): message parts` on stdout.
fn effect_log_line(level: &JsString, parts: &JsArray<JsString>, fiber_id: u64) {
    let now = date_now();
    let stamp = match date_local_parts(now) {
        Some(parts) => format!("{:02}:{:02}:{:02}.{:03}", parts.hours, parts.minutes, parts.seconds, parts.milliseconds),
        None => "00:00:00.000".to_owned(),
    };
    let mut line = format!("[{stamp}] {level} (#{fiber_id})");
    let count = array_len(parts) as usize;
    for index in 0..count {
        line.push(if index == 0 { ':' } else { ' ' });
        if index == 0 {
            line.push(' ');
        }
        line.push_str(array_get(parts, index as f64).as_ref());
    }
    if count == 0 {
        line.push(':');
    }
    line.push('\n');
    process_stdout_write(&string(&line));
}

fn no_trace() -> TraceFn {
    Box::new(|_| {})
}

fn bundle_of(value: &EffectValue) -> Bundle {
    value.downcast_ref::<Bundle>().expect("scriptc: a service bundle was expected").clone()
}

fn bundle_join(left: &Bundle, right: &Bundle) -> EffectValue {
    let mut joined: Vec<(Rc<str>, EffectValue)> = Vec::with_capacity(left.len() + right.len());
    joined.extend(left.iter().cloned());
    joined.extend(right.iter().cloned());
    Rc::new(Rc::new(joined) as Bundle)
}

/// A layer's BUILD as an effect answering its bundle: succeed/effect are
/// leaves, merge joins, provide feeds the inner bundle to the outer build
/// (hiding it unless merged). No memoization yet: a layer referenced twice
/// builds twice.
fn layer_build(layer: &JsEffect) -> JsEffect {
    let node = layer.with(|data| match &data.node {
        EffectNode::Layer(node) => node.clone(),
        _ => throw_error("scriptc: a layer was expected".to_owned()),
    });
    match node {
        LayerNode::Empty => effect_succeed(Rc::new(Rc::new(Vec::new()) as Bundle)),
        LayerNode::Succeed(key, value) => effect_succeed(Rc::new(Rc::new(vec![(key, value)]) as Bundle)),
        LayerNode::Effect(key, effect) => effect_map(&effect, Rc::new(move |value| Rc::new(Rc::new(vec![(key.clone(), value)]) as Bundle)), no_trace()),
        LayerNode::EffectDiscard(effect) => effect_map(&effect, Rc::new(|_| Rc::new(Rc::new(Vec::new()) as Bundle)), no_trace()),
        LayerNode::Merge(left, right) => {
            let right_build = layer_build(&right);
            effect_flat_map(
                &layer_build(&left),
                Rc::new(move |left_bundle| {
                    let left_bundle = bundle_of(&left_bundle);
                    effect_map(&right_build, Rc::new(move |right_bundle| bundle_join(&left_bundle, &bundle_of(&right_bundle))), no_trace())
                }),
                no_trace(),
            )
        }
        LayerNode::Provide(outer, inner, merge) => {
            let outer_build = layer_build(&outer);
            effect_flat_map(
                &layer_build(&inner),
                Rc::new(move |inner_bundle| {
                    let inner_bundle = bundle_of(&inner_bundle);
                    let provided = effect_new(EffectNode::ProvideBundle(outer_build.clone(), inner_bundle.clone()));
                    if merge {
                        effect_map(&provided, Rc::new(move |outer_bundle| bundle_join(&inner_bundle, &bundle_of(&outer_bundle))), no_trace())
                    } else {
                        provided
                    }
                }),
                no_trace(),
            )
        }
    }
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
    As(EffectValue),
    Ignore,
    ZipRight(JsEffect),
    Gen(Box<dyn EffectGen>),
    /// Leave a provide scope: drop this many environment entries.
    PopEnv(usize),
    /// A collection in progress: the next index to run, the values so far, the source and the collector.
    Collect(usize, Vec<EffectValue>, CollectSource, CollectFn),
    /// `tap`: run the callback's effect, then restore the value; `tapError` the same on the failure.
    Tap(EffectFn),
    TapError(EffectFn),
    /// Restore an earlier outcome once a side effect (tap, finalizer) succeeded; its own failure wins.
    Restore(Outcome),
    /// Leave a scope: run its finalizers (LIFO) with the exit, then restore the outcome.
    CloseScope,
    /// Finalizers still to run for an exit, then the outcome to restore.
    Finalize(Vec<FinalizerFn>, Outcome),
    Ensuring(JsEffect),
    /// `acquireRelease`: the resource arrived — register the release, answer the resource.
    Acquired(ReleaseFn),
    /// `acquireUseRelease`: the resource arrived — use it, then release with the use's exit.
    AcquiredUse(EffectFn, ReleaseFn),
    /// The resource and its release, waiting for `use`'s outcome.
    Using(EffectValue, ReleaseFn),
    /// `Effect.exit`: any outcome becomes a success carrying it.
    CaptureExit,
    OrElse(Rc<dyn Fn() -> EffectValue>),
    CatchIf(Rc<dyn Fn(EffectValue) -> bool>, EffectFn),
}

enum CollectSource {
    Items(Vec<EffectValue>, ItemFn),
    Effects(JsArray<JsEffect>),
}

impl CollectSource {
    fn len(&self) -> usize {
        match self {
            CollectSource::Items(items, _) => items.len(),
            CollectSource::Effects(effects) => array_len(effects) as usize,
        }
    }
    fn effect_at(&self, index: usize) -> JsEffect {
        match self {
            CollectSource::Items(items, f) => f(items[index].clone(), index as f64),
            CollectSource::Effects(effects) => array_get(effects, index as f64),
        }
    }
}

type Outcome = Result<EffectValue, EffectValue>;

enum Step {
    Done(Outcome),
    Push(Frame, JsEffect),
    /// Look a service up (`yield* Service`).
    Lookup(Rc<str>),
    /// Enter a provide scope with these services, then run the inner effect.
    Enter(Bundle, JsEffect),
    /// Start a collection over its source.
    Collect(CollectSource, CollectFn),
    /// Print a log line (needs the fiber's id).
    Log(JsString, JsArray<JsString>),
    /// Continue with another effect (suspend's thunk answered it).
    Run(JsEffect),
    /// Open a scope around the inner effect.
    OpenScope(JsEffect),
    /// Register a finalizer in the innermost scope.
    Finalizer(FinalizerFn),
    Resume(Box<dyn EffectGen>),
    /// Suspend on a promise; `recover` (tryPromise) turns a rejection into
    /// a failure, its absence (promise) makes the rejection a defect.
    Await(JsPromiseHandle, Option<RecoverFn>),
    /// Suspend on a kernel LATCH — a Deferred's completion, a Semaphore's permits: either the value is already
    /// there (resume now) or the fiber joins the latch's waiter list and the completer drives it.
    Park(Rc<RefCell<Latch>>),
    /// A queue operation: `None` takes (parking while empty), `Some(value)` offers (parking while full).
    Queue(Rc<RefCell<QueueState>>, Option<EffectValue>),
}

/// The waiting half of Deferred and Semaphore: a value once settled, and the fibers queued for it. A waiter is
/// a callback so the two shapes (a settled outcome, a freed permit) share one queue.
pub struct Latch {
    settled: Option<Outcome>,
    permits: f64,
    waiters: Vec<Box<dyn FnOnce(Outcome)>>,
}

impl Latch {
    fn new(permits: f64) -> Rc<RefCell<Self>> {
        Rc::new(RefCell::new(Latch { settled: None, permits, waiters: Vec::new() }))
    }
    /// Settle a Deferred: every waiting fiber resumes with the same outcome, and later awaits answer at once.
    fn settle(&mut self, outcome: Outcome) -> bool {
        if self.settled.is_some() {
            return false;
        }
        self.settled = Some(outcome.clone());
        for waiter in std::mem::take(&mut self.waiters) {
            waiter(outcome.clone());
        }
        true
    }
}

/// A defect (`Effect.die`, `orDie` over a failure, a rejected
/// `Effect.promise`) leaves the kernel as an ordinary scriptc throw.
fn effect_defect(defect: EffectValue) -> ! {
    let message = defect
        .downcast_ref::<JsString>()
        .map(|text| text.to_string())
        .or_else(|| defect.downcast_ref::<f64>().map(|n| number_to_string(*n).to_string()));
    match message {
        Some(message) => throw_error(message),
        // A program value (a schema error instance, a record): thrown as itself, like Effect's yieldable errors.
        None => rethrow_caught(caught_from_any(defect)),
    }
}

/// One running effect: the node being evaluated (or the outcome a
/// promise delivered), the continuation stack, and where the exit goes.
/// It lives in an `Rc` so a promise reaction can resume it.
pub struct EffectFiber {
    current: Option<JsEffect>,
    resumed: Option<Outcome>,
    frames: Vec<Frame>,
    /// The services in scope, innermost provide last.
    env: Vec<(Rc<str>, EffectValue)>,
    /// Open scopes' finalizers, innermost last (each in registration order).
    scopes: Vec<Vec<FinalizerFn>>,
    id: u64,
    on_exit: Option<Box<dyn FnOnce(Outcome)>>,
}

type FiberRef = Rc<RefCell<EffectFiber>>;

fn fiber_new(effect: &JsEffect, on_exit: Box<dyn FnOnce(Outcome)>) -> FiberRef {
    let id = EFFECT_FIBER_IDS.with(|ids| {
        ids.set(ids.get() + 1);
        ids.get()
    });
    Rc::new(RefCell::new(EffectFiber { current: Some(effect.clone()), resumed: None, frames: Vec::new(), env: Vec::new(), scopes: Vec::new(), id, on_exit: Some(on_exit) }))
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
        EffectNode::As(inner, value) => Step::Push(Frame::As(value.clone()), inner.clone()),
        EffectNode::Ignore(inner) => Step::Push(Frame::Ignore, inner.clone()),
        EffectNode::ZipRight(inner, next) => Step::Push(Frame::ZipRight(next.clone()), inner.clone()),
        EffectNode::Gen(make, _) => Step::Resume(make()),
        EffectNode::ServiceKey(key) => Step::Lookup(key.clone()),
        EffectNode::ProvideBundle(inner, bundle) => Step::Enter(bundle.clone(), inner.clone()),
        EffectNode::ProvideLayer(inner, layer) => {
            let inner = inner.clone();
            Step::Push(Frame::FlatMap(Rc::new(move |bundle| effect_new(EffectNode::ProvideBundle(inner.clone(), bundle_of(&bundle))))), layer_build(layer))
        }
        EffectNode::Layer(_) => throw_error("scriptc: a layer is not an effect (Effect.provide it)".to_owned()),
        EffectNode::ForEach(items, f, collect, _) => Step::Collect(CollectSource::Items(items.clone(), f.clone()), collect.clone()),
        EffectNode::Log(level, parts) => Step::Log(level.clone(), parts.clone()),
        EffectNode::Tap(inner, f, _) => Step::Push(Frame::Tap(f.clone()), inner.clone()),
        EffectNode::TapError(inner, f, _) => Step::Push(Frame::TapError(f.clone()), inner.clone()),
        EffectNode::Suspend(thunk, _) => Step::Run(thunk()),
        EffectNode::Sleep(millis) => Step::Await(promise_to_handle(&promise_timeout(*millis)), None),
        EffectNode::Scoped(inner) => Step::OpenScope(inner.clone()),
        EffectNode::AddFinalizer(finalizer, _) => Step::Finalizer(finalizer.clone()),
        EffectNode::Ensuring(inner, finalizer) => Step::Push(Frame::Ensuring(finalizer.clone()), inner.clone()),
        EffectNode::AcquireRelease(acquire, release, _) => Step::Push(Frame::Acquired(release.clone()), acquire.clone()),
        EffectNode::AcquireUseRelease(acquire, use_fn, release, _) => Step::Push(Frame::AcquiredUse(use_fn.clone(), release.clone()), acquire.clone()),
        EffectNode::Exit(inner) => Step::Push(Frame::CaptureExit, inner.clone()),
        EffectNode::Data(_) => throw_error("scriptc: a kernel data handle (an Exit or Option) is not an effect".to_owned()),
        EffectNode::Try(attempt, recover, _) => {
            let attempted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| attempt()));
            Step::Done(match attempted {
                Ok(value) => Ok(value),
                Err(payload) => {
                    if !is_scriptc_unwind(payload.as_ref()) {
                        std::panic::resume_unwind(payload);
                    }
                    Err(recover(caught_from_panic(payload)))
                }
            })
        }
        EffectNode::OrElseSucceed(inner, or_else, _) => Step::Push(Frame::OrElse(or_else.clone()), inner.clone()),
        EffectNode::CatchIf(inner, predicate, recover, _) => Step::Push(Frame::CatchIf(predicate.clone(), recover.clone()), inner.clone()),
        EffectNode::All(effects, collect) => Step::Collect(CollectSource::Effects(effects.clone()), collect.clone()),
        EffectNode::Park(latch) => Step::Park(latch.clone()),
        EffectNode::Queue(queue, value) => Step::Queue(queue.clone(), value.clone()),
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
                Step::Lookup(key) => {
                    let found = fiber.borrow().env.iter().rev().find(|(k, _)| *k == key).map(|(_, v)| v.clone());
                    match found {
                        Some(value) => Ok(value),
                        None => throw_error(format!("Service not found: {key}")),
                    }
                }
                Step::Run(next) => {
                    fiber.borrow_mut().current = Some(next);
                    continue;
                }
                Step::Log(level, parts) => {
                    let id = fiber.borrow().id;
                    effect_log_line(&level, &parts, id);
                    Ok(Rc::new(()))
                }
                Step::OpenScope(inner) => {
                    let mut state = fiber.borrow_mut();
                    state.scopes.push(Vec::new());
                    state.frames.push(Frame::CloseScope);
                    state.current = Some(inner);
                    continue;
                }
                Step::Finalizer(finalizer) => {
                    let mut state = fiber.borrow_mut();
                    match state.scopes.last_mut() {
                        Some(scope) => {
                            scope.push(finalizer);
                            drop(state);
                            Ok(Rc::new(()))
                        }
                        None => throw_error("Effect.addFinalizer outside a scope (Effect.scoped is missing)".to_owned()),
                    }
                }
                Step::Collect(source, collect) => {
                    if source.len() == 0 {
                        Ok(collect(Vec::new()))
                    } else {
                        let first = source.effect_at(0);
                        let mut state = fiber.borrow_mut();
                        state.frames.push(Frame::Collect(1, Vec::new(), source, collect));
                        state.current = Some(first);
                        continue;
                    }
                }
                Step::Enter(bundle, inner) => {
                    let mut state = fiber.borrow_mut();
                    state.env.extend(bundle.iter().cloned());
                    state.frames.push(Frame::PopEnv(bundle.len()));
                    state.current = Some(inner);
                    continue;
                }
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
                Step::Park(latch) => {
                    // Already settled (or a permit free): resume on this turn; otherwise queue and let the
                    // completer drive this fiber.
                    let ready = { let mut state = latch.borrow_mut(); match state.settled.clone() { Some(outcome) => Some(outcome), None => if state.permits >= 1.0 { state.permits -= 1.0; Some(Ok(Rc::new(()) as EffectValue)) } else { None } } };
                    match ready {
                        Some(outcome) => {
                            fiber.borrow_mut().resumed = Some(outcome);
                            continue;
                        }
                        None => {
                            let resumed = fiber.clone();
                            latch.borrow_mut().waiters.push(Box::new(move |outcome| {
                                resumed.borrow_mut().resumed = Some(outcome);
                                fiber_drive(&resumed);
                            }));
                            return;
                        }
                    }
                }
                Step::Queue(queue, value) => {
                    let resumed = fiber.clone();
                    match queue_step(&queue, value, Box::new(move |outcome| { resumed.borrow_mut().resumed = Some(outcome); fiber_drive(&resumed); })) {
                        Some(outcome) => { fiber.borrow_mut().resumed = Some(outcome); continue; }
                        None => return,
                    }
                }
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
                (Frame::As(value), Ok(_)) => {
                    outcome = Some(Ok(value));
                    None
                }
                (Frame::Ignore, _) => {
                    outcome = Some(Ok(Rc::new(())));
                    None
                }
                (Frame::ZipRight(next), Ok(_)) => Some(next),
                (Frame::Collect(next, mut done, source, collect), Ok(value)) => {
                    done.push(value);
                    if next < source.len() {
                        let effect = source.effect_at(next);
                        fiber.borrow_mut().frames.push(Frame::Collect(next + 1, done, source, collect));
                        Some(effect)
                    } else {
                        outcome = Some(Ok(collect(done)));
                        None
                    }
                }
                (Frame::Tap(f), Ok(value)) => {
                    fiber.borrow_mut().frames.push(Frame::Restore(Ok(value.clone())));
                    Some(f(value))
                }
                (Frame::TapError(f), Err(error)) => {
                    fiber.borrow_mut().frames.push(Frame::Restore(Err(error.clone())));
                    Some(f(error))
                }
                (Frame::Restore(stored), Ok(_)) => {
                    outcome = Some(stored);
                    None
                }
                (Frame::CloseScope, exit) => {
                    let finalizers = fiber.borrow_mut().scopes.pop().unwrap_or_default();
                    fiber.borrow_mut().frames.push(Frame::Finalize(finalizers, exit));
                    outcome = Some(Ok(Rc::new(())));
                    None
                }
                (Frame::Finalize(mut finalizers, exit), Ok(_)) => match finalizers.pop() {
                    Some(finalizer) => {
                        let next = finalizer(exit_handle(exit.clone()));
                        fiber.borrow_mut().frames.push(Frame::Finalize(finalizers, exit));
                        Some(next)
                    }
                    None => {
                        outcome = Some(exit);
                        None
                    }
                },
                (Frame::Ensuring(finalizer), exit) => {
                    fiber.borrow_mut().frames.push(Frame::Restore(exit));
                    Some(finalizer)
                }
                (Frame::Acquired(release), Ok(resource)) => {
                    let mut state = fiber.borrow_mut();
                    let value = resource.clone();
                    match state.scopes.last_mut() {
                        Some(scope) => scope.push(Rc::new(move |exit| release(value.clone(), exit))),
                        None => throw_error("Effect.acquireRelease outside a scope (Effect.scoped is missing)".to_owned()),
                    }
                    outcome = Some(Ok(resource));
                    None
                }
                (Frame::AcquiredUse(use_fn, release), Ok(resource)) => {
                    fiber.borrow_mut().frames.push(Frame::Using(resource.clone(), release));
                    Some(use_fn(resource))
                }
                (Frame::Using(resource, release), exit) => {
                    fiber.borrow_mut().frames.push(Frame::Restore(exit.clone()));
                    Some(release(resource, exit_handle(exit)))
                }
                (Frame::OrElse(or_else), Err(_)) => {
                    outcome = Some(Ok(or_else()));
                    None
                }
                (Frame::CatchIf(predicate, recover), Err(error)) => {
                    if predicate(error.clone()) {
                        Some(recover(error))
                    } else {
                        outcome = Some(Err(error));
                        None
                    }
                }
                (Frame::CaptureExit, exit) => {
                    outcome = Some(Ok(Rc::new(exit_handle(exit))));
                    None
                }
                (Frame::PopEnv(count), passthrough) => {
                    let mut state = fiber.borrow_mut();
                    let keep = state.env.len().saturating_sub(count);
                    state.env.truncate(keep);
                    outcome = Some(passthrough);
                    None
                }
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
pub fn effect_run_promise<T: HeapValue>(effect: &JsEffect, unbox: Rc<dyn Fn(&EffectValue) -> T>) -> JsPromise<T> {
    let promise = promise_new::<T>();
    let target = promise.clone();
    let fiber = fiber_new(
        effect,
        Box::new(move |outcome| match outcome {
            Ok(value) => {
                let _ = promise_fulfill(&target, unbox(&value));
            }
            Err(error) => {
                let _ = promise_reject(&target, caught_from_any(error));
            }
        }),
    );
    fiber_drive(&fiber);
    promise
}
