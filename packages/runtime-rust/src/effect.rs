/* The effect kernel: the native runtime behind `import { Effect } from
 * "effect"` in static builds (frontend/lowering/lower-effect.ts).
 *
 * An `Effect<A, E, R>` is a DESCRIPTION — a tree of nodes built by the
 * combinators and run by `effect_run_*`. Values cross the kernel as
 * `EffectValue` (an `Rc<dyn Any>`): generated code boxes what it knows
 * the type of and unboxes with the same type on the way out, so the
 * kernel stays monomorphic while the program keeps its native
 * representations. This first slice is the synchronous core:
 * succeed/sync/map/flatMap and the two runners. */

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

enum EffectNode {
    Succeed(EffectValue),
    Sync(Rc<dyn Fn() -> EffectValue>, TraceFn),
    Map(JsEffect, Rc<dyn Fn(EffectValue) -> EffectValue>, TraceFn),
    FlatMap(JsEffect, Rc<dyn Fn(EffectValue) -> JsEffect>, TraceFn),
}

pub struct EffectData {
    node: EffectNode,
}

impl Trace for EffectData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        match &self.node {
            EffectNode::Succeed(_) => {}
            EffectNode::Sync(_, trace) => trace(tracer),
            EffectNode::Map(inner, _, trace) | EffectNode::FlatMap(inner, _, trace) => {
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

pub fn effect_sync(thunk: Rc<dyn Fn() -> EffectValue>, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Sync(thunk, trace))
}

pub fn effect_map(source: &JsEffect, f: Rc<dyn Fn(EffectValue) -> EffectValue>, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::Map(source.clone(), f, trace))
}

pub fn effect_flat_map(source: &JsEffect, f: Rc<dyn Fn(EffectValue) -> JsEffect>, trace: TraceFn) -> JsEffect {
    effect_new(EffectNode::FlatMap(source.clone(), f, trace))
}

/// Run a description to its value on the current thread. Failure
/// channels arrive with the next slice; today every node succeeds or
/// throws through the ordinary scriptc unwind.
pub fn effect_run_sync(effect: &JsEffect) -> EffectValue {
    let mut current = effect.clone();
    // A continuation stack instead of recursion: `map` and `flatMap`
    // chains are as deep as the program's pipelines.
    let mut continuations: Vec<JsEffect> = Vec::new();
    loop {
        let next = current.with(|data| match &data.node {
            EffectNode::Succeed(value) => Ok(value.clone()),
            EffectNode::Sync(thunk, _) => Ok(thunk()),
            EffectNode::Map(inner, _, _) | EffectNode::FlatMap(inner, _, _) => Err(inner.clone()),
        });
        let mut value = match next {
            Ok(value) => value,
            Err(inner) => {
                continuations.push(current);
                current = inner;
                continue;
            }
        };
        loop {
            let Some(pending) = continuations.pop() else { return value };
            let step = pending.with(|data| match &data.node {
                EffectNode::Map(_, f, _) => Ok(f(value.clone())),
                EffectNode::FlatMap(_, f, _) => Err(f(value.clone())),
                EffectNode::Succeed(_) | EffectNode::Sync(..) => unreachable!("scriptc: effect continuation without a callback"),
            });
            match step {
                Ok(mapped) => value = mapped,
                Err(effect) => {
                    current = effect;
                    break;
                }
            }
        }
    }
}

/// `Effect.runPromise`: the value as a settled promise of the site's type.
pub fn effect_run_promise<T: HeapValue>(effect: &JsEffect) -> JsPromise<T> {
    promise_resolved(effect_unbox::<T>(&effect_run_sync(effect)))
}
