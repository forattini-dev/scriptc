#![forbid(unsafe_code)]

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::{Rc, Weak};

/// Owned JavaScript string handle for the static Rust heap.
///
/// `Rc` keeps aliasing explicit and thread-confined. Later heap object
/// families use the same owning-handle rule and add tracing for cycles.
pub type JsString = Rc<str>;

trait DynNode {
    fn id(&self) -> usize;
    fn trace(&self, tracer: &mut Tracer<'_>);
    fn clear_edges(&self);
}

type DynNodeRc = Rc<dyn DynNode>;
type DynNodeWeak = Weak<dyn DynNode>;

thread_local! {
    static NEXT_NODE_ID: Cell<usize> = const { Cell::new(1) };
    static LIVE_NODES: Cell<usize> = const { Cell::new(0) };
    static CYCLE_CANDIDATES: RefCell<Vec<DynNodeWeak>> = const { RefCell::new(Vec::new()) };
    static EXCEPTION_SLOT: RefCell<Option<Rc<dyn Any>>> = const { RefCell::new(None) };
}

/// Visitor used by generated heap payloads to expose owning edges.
///
/// The visitor stores only `Weak` references, so a collection pass never
/// changes the liveness result it is trying to compute.
pub struct Tracer<'a> {
    visit: &'a mut dyn FnMut(DynNodeWeak),
}

impl Tracer<'_> {
    pub fn edge<T>(&mut self, edge: &Gc<T>)
    where
        T: Trace + ClearEdges + 'static,
    {
        let node: DynNodeRc = edge.rc().clone();
        (self.visit)(Rc::downgrade(&node));
    }
}

/// Enumerates every owning heap edge in a payload.
pub trait Trace {
    fn trace(&self, tracer: &mut Tracer<'_>);
}

/// Removes every owning heap edge from a payload.
///
/// Collection calls this only for a set proven unreachable. Implementations
/// must leave scalar data valid, but may empty containers and `take()` object
/// fields. This explicit operation is what lets safe Rust break `Rc` cycles.
pub trait ClearEdges {
    fn clear_edges(&mut self);
}

struct Node<T> {
    id: usize,
    value: RefCell<T>,
}

impl<T> DynNode for Node<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn id(&self) -> usize {
        self.id
    }

    fn trace(&self, tracer: &mut Tracer<'_>) {
        self.value.borrow().trace(tracer);
    }

    fn clear_edges(&self) {
        self.value.borrow_mut().clear_edges();
    }
}

impl<T> Drop for Node<T> {
    fn drop(&mut self) {
        LIVE_NODES.with(|count| count.set(count.get() - 1));
    }
}

/// Owned, address-stable handle for JavaScript heap objects.
///
/// `Gc<T>` deliberately exposes closure-based borrows instead of Rust
/// references whose lifetime could escape a runtime operation. Cloning a
/// handle preserves JavaScript identity. Dropping a handle records a weak
/// cycle candidate; `collect_cycles` performs safe trial deletion later.
pub struct Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    inner: Option<Rc<Node<T>>>,
}

impl<T> Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    pub fn new(value: T) -> Self {
        let id = NEXT_NODE_ID.with(|next| {
            let id = next.get();
            next.set(id.checked_add(1).expect("scriptc: heap id overflow"));
            id
        });
        LIVE_NODES.with(|count| count.set(count.get() + 1));
        Self {
            inner: Some(Rc::new(Node {
                id,
                value: RefCell::new(value),
            })),
        }
    }

    pub fn with<R>(&self, read: impl FnOnce(&T) -> R) -> R {
        read(&self.rc().value.borrow())
    }

    pub fn with_mut<R>(&self, write: impl FnOnce(&mut T) -> R) -> R {
        write(&mut self.rc().value.borrow_mut())
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(self.rc(), other.rc())
    }

    fn rc(&self) -> &Rc<Node<T>> {
        self.inner.as_ref().expect("scriptc: moved heap handle")
    }
}

impl<T> Clone for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn clone(&self) -> Self {
        Self {
            inner: Some(self.rc().clone()),
        }
    }
}

impl<T> Drop for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn drop(&mut self) {
        let Some(node) = self.inner.take() else {
            return;
        };
        let erased: DynNodeRc = node.clone();
        let candidate = Rc::downgrade(&erased);
        drop(erased);
        drop(node);
        if candidate.strong_count() > 0 {
            CYCLE_CANDIDATES.with(|candidates| candidates.borrow_mut().push(candidate));
        }
    }
}

/// Collect cycles reachable from handles whose reference count decreased.
///
/// The pass snapshots the candidate subgraph, subtracts its internal edges
/// from each node's strong count, marks nodes with outside owners as live,
/// then clears edges only in the unmarked remainder. Working references are
/// explicitly discounted, so the collector itself never keeps garbage live.
pub fn collect_cycles() -> usize {
    let candidates = CYCLE_CANDIDATES.with(|buffer| std::mem::take(&mut *buffer.borrow_mut()));
    let mut nodes = Vec::<DynNodeRc>::new();
    let mut positions = HashMap::<usize, usize>::new();
    let mut queue = VecDeque::<DynNodeRc>::new();

    for candidate in candidates {
        if let Some(node) = candidate.upgrade()
            && !positions.contains_key(&node.id())
        {
            positions.insert(node.id(), nodes.len());
            nodes.push(node.clone());
            queue.push_back(node);
        }
    }

    while let Some(node) = queue.pop_front() {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                if positions.contains_key(&child.id()) {
                    return;
                }
                positions.insert(child.id(), nodes.len());
                nodes.push(child.clone());
                queue.push_back(child);
            },
        });
    }

    if nodes.is_empty() {
        return 0;
    }

    let mut incoming = vec![0usize; nodes.len()];
    for node in &nodes {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                if let Some(child) = child.upgrade()
                    && let Some(index) = positions.get(&child.id())
                {
                    incoming[*index] += 1;
                }
            },
        });
    }

    let mut live = HashSet::<usize>::new();
    let mut live_queue = VecDeque::<usize>::new();
    for (index, node) in nodes.iter().enumerate() {
        // One strong reference per node belongs to `nodes`; every other
        // reference not represented by an incoming edge is an outside root.
        let outside = Rc::strong_count(node).saturating_sub(1 + incoming[index]);
        if outside > 0 && live.insert(node.id()) {
            live_queue.push_back(index);
        }
    }

    while let Some(index) = live_queue.pop_front() {
        nodes[index].trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                let Some(child_index) = positions.get(&child.id()).copied() else {
                    return;
                };
                if live.insert(child.id()) {
                    live_queue.push_back(child_index);
                }
            },
        });
    }

    let garbage: Vec<_> = nodes
        .iter()
        .filter(|node| !live.contains(&node.id()))
        .cloned()
        .collect();
    let collected = garbage.len();
    for node in &garbage {
        node.clear_edges();
    }
    drop(garbage);
    drop(nodes);
    collected
}

/// Final safe point for generated executables.
///
/// The optional audit is test-only instrumentation: production binaries pay
/// only the final cycle pass, while differential tests can prove that every
/// traced array/record object was released.
pub fn finish() {
    collect_cycles();
    if std::env::var_os("SCRIPTC_RUST_HEAP_AUDIT").is_some() {
        let live = live_heap_objects();
        assert_eq!(live, 0, "scriptc: {live} Rust heap object(s) still live");
    }
}

#[doc(hidden)]
pub fn live_heap_objects() -> usize {
    LIVE_NODES.with(Cell::get)
}

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
impl HeapValue for JsString {}
impl HeapValue for JsError {}

impl<T> HeapValue for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn trace_value(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(self);
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsError {
    name: String,
    message: String,
}

impl Trace for JsError {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

pub fn error_new(name: &str, message: JsString) -> JsError {
    JsError {
        name: name.to_owned(),
        message: message.to_string(),
    }
}

#[derive(Clone)]
pub struct Caught {
    value: Rc<dyn Any>,
}

pub enum Completion<T> {
    Normal,
    Return(T),
    Throw(Caught),
    Break(usize),
    Continue(usize),
}

struct ScriptThrow;

pub fn throw_value<T: 'static>(value: T) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(Rc::new(value));
        assert!(
            previous.is_none(),
            "scriptc: throw with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn throw_reference_error(message: String) -> ! {
    throw_value(JsError {
        name: "ReferenceError".to_owned(),
        message,
    })
}

pub fn caught_from_panic(payload: Box<dyn Any + Send>) -> Caught {
    match payload.downcast::<ScriptThrow>() {
        Ok(_) => EXCEPTION_SLOT.with(|slot| Caught {
            value: slot
                .borrow_mut()
                .take()
                .expect("scriptc: throw marker without an exception value"),
        }),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

pub fn rethrow_caught(caught: Caught) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(caught.value);
        assert!(
            previous.is_none(),
            "scriptc: rethrow with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn caught_is_error(caught: &Caught) -> bool {
    caught.value.is::<JsError>()
}

pub fn caught_error_name(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.name.as_str())
}

pub fn caught_error_message(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.message.as_str())
}

/// A value that may be stored in a traced JavaScript array.
pub trait ArrayElement: Clone + 'static {
    fn trace_element(&self, _tracer: &mut Tracer<'_>) {}
}

pub trait JoinElement: ArrayElement {
    fn append_joined(&self, output: &mut String);
}

impl ArrayElement for f64 {}
impl ArrayElement for bool {}
impl ArrayElement for usize {}
impl ArrayElement for JsString {}

impl JoinElement for f64 {
    fn append_joined(&self, output: &mut String) {
        output.push_str(&format_number(*self));
    }
}

impl JoinElement for bool {
    fn append_joined(&self, output: &mut String) {
        output.push_str(if *self { "true" } else { "false" });
    }
}

impl JoinElement for JsString {
    fn append_joined(&self, output: &mut String) {
        output.push_str(self);
    }
}

impl<T> ArrayElement for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn trace_element(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(self);
    }
}

pub struct ArrayData<T: ArrayElement> {
    elements: Vec<T>,
}

impl<T: ArrayElement> Trace for ArrayData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for element in &self.elements {
            element.trace_element(tracer);
        }
    }
}

impl<T: ArrayElement> ClearEdges for ArrayData<T> {
    fn clear_edges(&mut self) {
        self.elements.clear();
    }
}

pub type JsArray<T> = Gc<ArrayData<T>>;

pub fn array_new<T: ArrayElement>(elements: Vec<T>) -> JsArray<T> {
    Gc::new(ArrayData { elements })
}

pub fn array_len<T: ArrayElement>(array: &JsArray<T>) -> f64 {
    array.with(|data| data.elements.len() as f64)
}

pub fn array_get<T: ArrayElement>(array: &JsArray<T>, index: f64) -> T {
    let index = array_index(index, false, array_len(array) as usize);
    array.with(|data| data.elements[index].clone())
}

pub fn array_set<T: ArrayElement>(array: &JsArray<T>, index: f64, value: T) {
    let len = array_len(array) as usize;
    let index = array_index(index, true, len);
    array.with_mut(|data| {
        if index == len {
            data.elements.push(value);
        } else {
            data.elements[index] = value;
        }
    });
}

pub fn array_push<T: ArrayElement>(array: &JsArray<T>, value: T) -> f64 {
    array.with_mut(|data| {
        data.elements.push(value);
        data.elements.len() as f64
    })
}

pub fn array_extend<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    let snapshot = source.with(|data| data.elements.clone());
    array.with_mut(|data| {
        data.elements.extend(snapshot);
        data.elements.len() as f64
    })
}

pub fn array_index_of_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> f64
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| {
        data.elements
            .iter()
            .position(|element| equal(element, needle))
            .map_or(-1.0, |index| index as f64)
    })
}

pub fn array_includes_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> bool
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| data.elements.iter().any(|element| equal(element, needle)))
}

pub fn array_join<T: JoinElement>(array: &JsArray<T>, separator: &JsString) -> JsString {
    array.with(|data| {
        let mut output = String::new();
        for (index, element) in data.elements.iter().enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            element.append_joined(&mut output);
        }
        Rc::<str>::from(output)
    })
}

pub fn array_pop<T: ArrayElement>(array: &JsArray<T>) -> T {
    array
        .with_mut(|data| data.elements.pop())
        .expect("scriptc: array index out of bounds")
}

pub fn array_ptr_eq<T: ArrayElement>(left: &JsArray<T>, right: &JsArray<T>) -> bool {
    left.ptr_eq(right)
}

pub struct MapData<K: Clone + 'static, V: HeapValue> {
    entries: Vec<Option<(K, V)>>,
    live: usize,
    iteration_depth: usize,
}

impl<K: Clone + 'static, V: HeapValue> Trace for MapData<K, V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for entry in &self.entries {
            if let Some((_, value)) = entry {
                value.trace_value(tracer);
            }
        }
    }
}

impl<K: Clone + 'static, V: HeapValue> ClearEdges for MapData<K, V> {
    fn clear_edges(&mut self) {
        self.entries.clear();
    }
}

pub type JsMap<K, V> = Gc<MapData<K, V>>;

pub fn map_new<K: Clone + 'static, V: HeapValue>() -> JsMap<K, V> {
    Gc::new(MapData {
        entries: Vec::new(),
        live: 0,
        iteration_depth: 0,
    })
}

pub fn map_set_by<K, V, F>(map: &JsMap<K, V>, key: K, value: V, equal: F)
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        if let Some((_, stored)) = data
            .entries
            .iter_mut()
            .flatten()
            .find(|(stored, _)| equal(stored, &key))
        {
            *stored = value;
        } else {
            data.entries.push(Some((key, value)));
            data.live += 1;
        }
    });
}

pub fn map_get_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> Option<V>
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .find(|(stored, _)| equal(stored, key))
            .map(|(_, value)| value.clone())
    })
}

pub fn map_has_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .any(|(stored, _)| equal(stored, key))
    })
}

pub fn map_delete_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        let Some(index) = data
            .entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|(stored, _)| equal(stored, key)))
        else {
            return false;
        };
        data.entries[index] = None;
        data.live -= 1;
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
        true
    })
}

pub fn map_size<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.live as f64)
}

pub fn map_clear<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.live = 0;
        if data.iteration_depth == 0 {
            data.entries.clear();
        } else {
            for entry in &mut data.entries {
                *entry = None;
            }
        }
    });
}

pub fn map_iter_count<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.entries.len() as f64)
}

pub fn map_iter_live<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> bool {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| data.entries[index].is_some())
}

pub fn map_iter_key<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> K {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map key read from a tombstone")
            .0
            .clone()
    })
}

pub fn map_iter_value<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> V {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map value read from a tombstone")
            .1
            .clone()
    })
}

pub fn map_iter_enter<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| data.iteration_depth += 1);
}

pub fn map_iter_exit<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.iteration_depth = data
            .iteration_depth
            .checked_sub(1)
            .expect("scriptc: unbalanced map iteration exit");
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
    });
}

pub type JsSet<T> = JsMap<T, bool>;

pub fn set_new<T: Clone + 'static>() -> JsSet<T> {
    map_new()
}

pub fn set_from_array_by<T, N, F>(source: &JsArray<T>, normalize: N, equal: F) -> JsSet<T>
where
    T: ArrayElement,
    N: Fn(T) -> T,
    F: Fn(&T, &T) -> bool + Copy,
{
    let set = set_new();
    let values = source.with(|data| data.elements.clone());
    for value in values {
        map_set_by(&set, normalize(value), true, equal);
    }
    set
}

pub fn set_add_by<T, F>(set: &JsSet<T>, value: T, equal: F)
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_set_by(set, value, true, equal);
}

pub fn set_has_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_has_by(set, value, equal)
}

pub fn set_delete_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_delete_by(set, value, equal)
}

fn array_index(index: f64, allow_end: bool, len: usize) -> usize {
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 || index > usize::MAX as f64 {
        panic!("scriptc: invalid array index");
    }
    let index = index as usize;
    if index > len || (!allow_end && index == len) {
        panic!("scriptc: array index out of bounds");
    }
    index
}

pub fn empty_string() -> JsString {
    Rc::from("")
}

pub fn string(value: &str) -> JsString {
    Rc::from(value)
}

pub fn string_concat(left: &JsString, right: &JsString) -> JsString {
    let mut result = String::with_capacity(left.len() + right.len());
    result.push_str(left);
    result.push_str(right);
    Rc::from(result)
}

pub fn string_len(value: &JsString) -> f64 {
    value.encode_utf16().count() as f64
}

pub fn string_char_at(value: &JsString, index: f64) -> JsString {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return empty_string();
    }
    let target = index as usize;
    let mut position = 0usize;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if target == position {
            return if width == 1 {
                Rc::from(ch.to_string())
            } else {
                // Like the C runtime, safe UTF-8 storage cannot represent
                // the lone surrogate JavaScript returns for an astral half.
                string("\u{fffd}")
            };
        }
        if width == 2 && target == position + 1 {
            return string("\u{fffd}");
        }
        position += width;
    }
    empty_string()
}

pub fn string_repeat(value: &JsString, count: f64) -> JsString {
    if !count.is_finite() || count < 0.0 {
        panic!("RangeError: Invalid count value");
    }
    Rc::<str>::from(value.repeat(count.trunc() as usize))
}

pub fn string_to_lower_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_lowercase())
}

pub fn number_to_string(value: f64) -> JsString {
    Rc::from(format_number(value))
}

pub fn bool_to_string(value: bool) -> JsString {
    string(if value { "true" } else { "false" })
}

pub fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == f64::INFINITY {
        return "Infinity".to_owned();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    value.to_string()
}

pub fn display_string(value: &JsString) -> String {
    value.to_string()
}

pub fn display_number(value: f64) -> String {
    if value == 0.0 && value.is_sign_negative() {
        "-0".to_owned()
    } else {
        format_number(value)
    }
}

pub fn display_bool(value: bool) -> String {
    if value { "true" } else { "false" }.to_owned()
}

pub fn number_same_value(left: f64, right: f64) -> bool {
    if left.is_nan() && right.is_nan() {
        return true;
    }
    if left == 0.0 && right == 0.0 {
        return left.is_sign_negative() == right.is_sign_negative();
    }
    left == right
}

pub fn console_log(values: &[String]) {
    println!("{}", values.join(" "));
}

pub fn console_error(values: &[String]) {
    eprintln!("{}", values.join(" "));
}

pub fn to_int32(value: f64) -> i32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    let truncated = value.trunc();
    let modulo = truncated.rem_euclid(4_294_967_296.0);
    if modulo >= 2_147_483_648.0 {
        (modulo - 4_294_967_296.0) as i32
    } else {
        modulo as i32
    }
}

pub fn to_uint32(value: f64) -> u32 {
    to_int32(value) as u32
}

pub fn bit_not(value: f64) -> f64 {
    (!to_int32(value)) as f64
}

pub fn bit_and(left: f64, right: f64) -> f64 {
    (to_int32(left) & to_int32(right)) as f64
}

pub fn bit_or(left: f64, right: f64) -> f64 {
    (to_int32(left) | to_int32(right)) as f64
}

pub fn bit_xor(left: f64, right: f64) -> f64 {
    (to_int32(left) ^ to_int32(right)) as f64
}

pub fn shift_left(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shl(to_uint32(right) & 31) as f64
}

pub fn shift_right(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shr(to_uint32(right) & 31) as f64
}

pub fn shift_right_unsigned(left: f64, right: f64) -> f64 {
    to_uint32(left).wrapping_shr(to_uint32(right) & 31) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Link {
        next: Option<Gc<Link>>,
    }

    impl Trace for Link {
        fn trace(&self, tracer: &mut Tracer<'_>) {
            if let Some(next) = &self.next {
                tracer.edge(next);
            }
        }
    }

    impl ClearEdges for Link {
        fn clear_edges(&mut self) {
            self.next = None;
        }
    }

    #[test]
    fn formats_javascript_special_numbers() {
        assert_eq!(format_number(f64::NAN), "NaN");
        assert_eq!(format_number(f64::INFINITY), "Infinity");
        assert_eq!(format_number(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(format_number(-0.0), "0");
        assert_eq!(display_number(-0.0), "-0");
    }

    #[test]
    fn char_at_uses_javascript_utf16_indexes() {
        let value = string("Aé🎉Z");
        assert_eq!(string_char_at(&value, f64::NAN).as_ref(), "A");
        assert_eq!(string_char_at(&value, 1.9).as_ref(), "é");
        assert_eq!(string_char_at(&value, 2.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 3.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 4.0).as_ref(), "Z");
        assert_eq!(string_char_at(&value, -1.0).as_ref(), "");
        assert_eq!(string_char_at(&value, f64::INFINITY).as_ref(), "");
    }

    #[test]
    fn bitwise_conversions_follow_ecmascript_width() {
        assert_eq!(bit_not(0.0), -1.0);
        assert_eq!(shift_right_unsigned(-1.0, 1.0), 2_147_483_647.0);
    }

    #[test]
    fn same_value_distinguishes_signed_zero_and_matches_nan() {
        assert!(number_same_value(f64::NAN, f64::NAN));
        assert!(!number_same_value(0.0, -0.0));
        assert!(number_same_value(-0.0, -0.0));
    }

    #[test]
    fn arrays_preserve_aliasing_and_release_acyclic_values() {
        let baseline = live_heap_objects();
        {
            let array = array_new(vec![1.0, 2.0]);
            let alias = array.clone();
            array_set(&alias, 1.0, 9.0);
            assert_eq!(array_get(&array, 1.0), 9.0);
            assert!(array_ptr_eq(&array, &alias));
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn captured_cells_share_mutations_and_trace_heap_values() {
        let baseline = live_heap_objects();
        {
            let number = cell_new(1.0);
            let alias = number.clone();
            cell_set(&alias, 9.0);
            assert_eq!(cell_get(&number), 9.0);

            let array = array_new(vec![2.0]);
            let captured = cell_new(array.clone());
            drop(array);
            assert_eq!(array_get(&cell_get(&captured), 0.0), 2.0);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn tdz_reads_unwind_as_typed_catchable_reference_errors() {
        let cell = cell_empty::<JsString>();
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cell_get_tdz(&cell, "answer")
        }))
        .expect_err("an empty TDZ cell must unwind");
        let caught = caught_from_panic(payload);
        assert!(caught_is_error(&caught));
        assert_eq!(caught_error_name(&caught).as_ref(), "ReferenceError");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "Cannot access 'answer' before initialization"
        );

        cell_set(&cell, string("ready"));
        assert_eq!(cell_get_tdz(&cell, "answer").as_ref(), "ready");
    }

    #[test]
    fn catch_conversion_rethrows_non_javascript_panics() {
        let payload = std::panic::catch_unwind(|| {
            std::panic::resume_unwind(Box::new("internal bug".to_owned()))
        })
        .expect_err("the synthetic internal panic must unwind");
        let propagated =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| caught_from_panic(payload)));
        assert!(propagated.is_err());
    }

    #[test]
    fn collector_breaks_self_and_mutual_cycles_without_unsafe() {
        let baseline = live_heap_objects();

        let self_cycle = Gc::new(Link { next: None });
        self_cycle.with_mut(|link| link.next = Some(self_cycle.clone()));
        drop(self_cycle);

        let left = Gc::new(Link { next: None });
        let right = Gc::new(Link { next: None });
        left.with_mut(|link| link.next = Some(right.clone()));
        right.with_mut(|link| link.next = Some(left.clone()));
        drop(left);
        drop(right);

        assert_eq!(live_heap_objects(), baseline + 3);
        assert_eq!(collect_cycles(), 3);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn collector_keeps_a_cycle_with_an_outside_owner() {
        let baseline = live_heap_objects();
        let rooted = Gc::new(Link { next: None });
        rooted.with_mut(|link| link.next = Some(rooted.clone()));

        let released_alias = rooted.clone();
        drop(released_alias);
        assert_eq!(collect_cycles(), 0);
        assert_eq!(live_heap_objects(), baseline + 1);

        drop(rooted);
        assert_eq!(collect_cycles(), 1);
        assert_eq!(live_heap_objects(), baseline);
    }
}
