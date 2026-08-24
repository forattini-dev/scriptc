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

    pub fn identity(&self) -> usize {
        self.rc().id
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

pub fn throw_type_error(message: String) -> ! {
    throw_value(JsError {
        name: "TypeError".to_owned(),
        message,
    })
}

pub fn throw_syntax_error(message: String) -> ! {
    throw_value(JsError {
        name: "SyntaxError".to_owned(),
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

pub fn caught_is_error_class(caught: &Caught, name: &str) -> bool {
    caught
        .value
        .downcast_ref::<JsError>()
        .is_some_and(|error| name == "Error" || error.name == name)
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

pub fn string_char_code_at(value: &JsString, index: f64) -> f64 {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return f64::NAN;
    }
    value
        .encode_utf16()
        .nth(index as usize)
        .map_or(f64::NAN, f64::from)
}

fn relative_string_index(index: f64, len: usize) -> usize {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if index == f64::NEG_INFINITY {
        return 0;
    }
    if index == f64::INFINITY {
        return len;
    }
    if index < 0.0 {
        (len as f64 + index).clamp(0.0, len as f64) as usize
    } else {
        index.clamp(0.0, len as f64) as usize
    }
}

pub fn string_index_of(value: &JsString, search: &JsString, from_index: f64) -> f64 {
    let haystack: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    let start = if from_index.is_nan() {
        0
    } else if from_index == f64::INFINITY {
        haystack.len()
    } else {
        from_index.trunc().clamp(0.0, haystack.len() as f64) as usize
    };
    if needle.is_empty() {
        return start as f64;
    }
    haystack[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map_or(-1.0, |index| (start + index) as f64)
}

pub fn string_slice(value: &JsString, start: f64, end: f64) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let start = relative_string_index(start, units.len());
    let end = relative_string_index(end, units.len());
    if end <= start {
        return empty_string();
    }
    Rc::from(String::from_utf16_lossy(&units[start..end]))
}

pub fn string_repeat(value: &JsString, count: f64) -> JsString {
    let count = if count.is_nan() { 0.0 } else { count.trunc() };
    if !count.is_finite() || count < 0.0 {
        panic!("RangeError: Invalid count value");
    }
    Rc::<str>::from(value.repeat(count as usize))
}

pub fn string_to_lower_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_lowercase())
}

pub fn string_to_upper_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_uppercase())
}

pub fn string_includes(value: &JsString, search: &JsString, from_index: f64) -> bool {
    string_index_of(value, search, from_index) >= 0.0
}

pub fn string_starts_with(value: &JsString, search: &JsString) -> bool {
    value.starts_with(search.as_ref())
}

pub fn string_ends_with(value: &JsString, search: &JsString) -> bool {
    value.ends_with(search.as_ref())
}

fn javascript_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn string_trim(value: &JsString) -> JsString {
    Rc::from(value.trim_matches(javascript_whitespace))
}

pub fn number_to_string(value: f64) -> JsString {
    Rc::from(format_number(value))
}

pub fn bool_to_string(value: bool) -> JsString {
    string(if value { "true" } else { "false" })
}

pub trait JsonValue {
    fn write_json(&self, writer: &mut JsonWriter);

    fn is_json_undefined(&self) -> bool {
        false
    }
}

pub trait JsonObject: Trace + ClearEdges + 'static {
    fn write_json_object(&self, writer: &mut JsonWriter);
}

pub struct JsonWriter {
    output: String,
    stack: HashSet<usize>,
}

impl JsonWriter {
    fn new() -> Self {
        Self {
            output: String::new(),
            stack: HashSet::new(),
        }
    }

    pub fn begin_array(&mut self) {
        self.output.push('[');
    }

    pub fn end_array(&mut self) {
        self.output.push(']');
    }

    pub fn begin_object(&mut self) {
        self.output.push('{');
    }

    pub fn end_object(&mut self) {
        self.output.push('}');
    }

    pub fn element<T: JsonValue>(&mut self, first: &mut bool, value: &T) {
        if !*first {
            self.output.push(',');
        }
        *first = false;
        value.write_json(self);
    }

    pub fn property<T: JsonValue>(&mut self, first: &mut bool, name: &str, value: &T) {
        if value.is_json_undefined() {
            return;
        }
        if !*first {
            self.output.push(',');
        }
        *first = false;
        self.write_string(name);
        self.output.push(':');
        value.write_json(self);
    }

    pub fn write_null(&mut self) {
        self.output.push_str("null");
    }

    fn write_string(&mut self, value: &str) {
        self.output.push('"');
        for ch in value.chars() {
            match ch {
                '"' => self.output.push_str("\\\""),
                '\\' => self.output.push_str("\\\\"),
                '\u{0008}' => self.output.push_str("\\b"),
                '\u{000c}' => self.output.push_str("\\f"),
                '\n' => self.output.push_str("\\n"),
                '\r' => self.output.push_str("\\r"),
                '\t' => self.output.push_str("\\t"),
                '\u{0000}'..='\u{001f}' => {
                    self.output.push_str(&format!("\\u{:04x}", ch as u32));
                }
                _ => self.output.push(ch),
            }
        }
        self.output.push('"');
    }
}

impl JsonValue for f64 {
    fn write_json(&self, writer: &mut JsonWriter) {
        if self.is_finite() {
            writer.output.push_str(&format_number(*self));
        } else {
            writer.write_null();
        }
    }
}

impl JsonValue for bool {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.output.push_str(if *self { "true" } else { "false" });
    }
}

impl JsonValue for JsString {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.write_string(self);
    }
}

impl<T> JsonValue for Gc<T>
where
    T: JsonObject,
{
    fn write_json(&self, writer: &mut JsonWriter) {
        let id = self.identity();
        if !writer.stack.insert(id) {
            throw_type_error("Converting circular structure to JSON".to_owned());
        }
        self.with(|value| value.write_json_object(writer));
        assert!(writer.stack.remove(&id));
    }
}

impl<T> JsonObject for ArrayData<T>
where
    T: ArrayElement + JsonValue,
{
    fn write_json_object(&self, writer: &mut JsonWriter) {
        writer.begin_array();
        let mut first = true;
        for value in &self.elements {
            writer.element(&mut first, value);
        }
        writer.end_array();
    }
}

pub fn json_stringify<T: JsonValue>(value: &T) -> JsString {
    let mut writer = JsonWriter::new();
    value.write_json(&mut writer);
    Rc::from(writer.output)
}

pub enum JsonNode {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsonNode>),
    Object(Vec<(String, JsonNode)>),
}

impl JsonNode {
    fn kind(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "boolean",
            Self::Number(_) => "number",
            Self::String(_) => "string",
            Self::Array(_) => "array",
            Self::Object(_) => "object",
        }
    }
}

pub trait JsonDecode: Sized {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub trait JsonObjectDecode: Trace + ClearEdges + Sized + 'static {
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub fn json_type_error(path: &str, expected: &str, node: &JsonNode) -> String {
    format!("expected {expected} at {path}, got {}", node.kind())
}

pub fn json_property_path(path: &str, property: &str) -> String {
    format!("{path}.{property}")
}

pub fn json_index_path(path: &str, index: usize) -> String {
    format!("{path}[{index}]")
}

pub fn json_expect_object<'a>(
    node: &'a JsonNode,
    path: &str,
) -> Result<&'a [(String, JsonNode)], String> {
    match node {
        JsonNode::Object(fields) => Ok(fields),
        _ => Err(json_type_error(path, "object", node)),
    }
}

pub fn json_expect_array<'a>(node: &'a JsonNode, path: &str) -> Result<&'a [JsonNode], String> {
    match node {
        JsonNode::Array(elements) => Ok(elements),
        _ => Err(json_type_error(path, "array", node)),
    }
}

pub fn json_object_field<'a>(object: &'a [(String, JsonNode)], name: &str) -> Option<&'a JsonNode> {
    object
        .iter()
        .rev()
        .find_map(|(key, value)| (key == name).then_some(value))
}

pub fn json_required_field<'a>(
    object: &'a [(String, JsonNode)],
    name: &str,
    path: &str,
) -> Result<&'a JsonNode, String> {
    json_object_field(object, name).ok_or_else(|| format!("expected property '{}' at {path}", name))
}

impl JsonDecode for f64 {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Number(value) => Ok(*value),
            _ => Err(json_type_error(path, "number", node)),
        }
    }
}

impl JsonDecode for bool {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Bool(value) => Ok(*value),
            _ => Err(json_type_error(path, "boolean", node)),
        }
    }
}

impl JsonDecode for JsString {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::String(value) => Ok(value.clone()),
            _ => Err(json_type_error(path, "string", node)),
        }
    }
}

impl<T> JsonDecode for Gc<T>
where
    T: JsonObjectDecode,
{
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        Ok(Gc::new(T::decode_json_object(node, path)?))
    }
}

impl<T> JsonObjectDecode for ArrayData<T>
where
    T: ArrayElement + JsonDecode,
{
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String> {
        let elements = json_expect_array(node, path)?;
        let mut decoded = Vec::with_capacity(elements.len());
        for (index, element) in elements.iter().enumerate() {
            decoded.push(T::decode_json(element, &json_index_path(path, index))?);
        }
        Ok(Self { elements: decoded })
    }
}

pub fn json_parse_typed<T: JsonDecode>(text: &JsString) -> T {
    let node = JsonParser::new(text)
        .parse()
        .unwrap_or_else(|message| throw_syntax_error(message));
    T::decode_json(&node, "$").unwrap_or_else(|message| throw_type_error(message))
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            position: 0,
        }
    }

    fn parse(mut self) -> Result<JsonNode, String> {
        self.whitespace();
        let value = self.value()?;
        self.whitespace();
        if self.position != self.bytes.len() {
            return self.syntax("unexpected trailing input");
        }
        Ok(value)
    }

    fn value(&mut self) -> Result<JsonNode, String> {
        self.whitespace();
        match self.peek() {
            Some(b'n') => {
                self.keyword(b"null")?;
                Ok(JsonNode::Null)
            }
            Some(b't') => {
                self.keyword(b"true")?;
                Ok(JsonNode::Bool(true))
            }
            Some(b'f') => {
                self.keyword(b"false")?;
                Ok(JsonNode::Bool(false))
            }
            Some(b'"') => Ok(JsonNode::String(Rc::from(self.string()?))),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.syntax("unexpected token"),
        }
    }

    fn array(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut elements = Vec::new();
        if self.take(b']') {
            return Ok(JsonNode::Array(elements));
        }
        loop {
            elements.push(self.value()?);
            self.whitespace();
            if self.take(b']') {
                return Ok(JsonNode::Array(elements));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or ']'");
            }
        }
    }

    fn object(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut fields = Vec::new();
        if self.take(b'}') {
            return Ok(JsonNode::Object(fields));
        }
        loop {
            self.whitespace();
            if self.peek() != Some(b'"') {
                return self.syntax("expected a string property name");
            }
            let name = self.string()?;
            self.whitespace();
            if !self.take(b':') {
                return self.syntax("expected ':'");
            }
            fields.push((name, self.value()?));
            self.whitespace();
            if self.take(b'}') {
                return Ok(JsonNode::Object(fields));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or '}'");
            }
        }
    }

    fn number(&mut self) -> Result<JsonNode, String> {
        let start = self.position;
        self.take(b'-');
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return self.syntax("invalid number"),
        }
        if self.take(b'.') {
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number fraction");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number exponent");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        let spelling = std::str::from_utf8(&self.bytes[start..self.position])
            .map_err(|_| "invalid UTF-8 in JSON number".to_owned())?;
        let value = spelling
            .parse::<f64>()
            .map_err(|_| format!("invalid JSON number at byte {start}"))?;
        Ok(JsonNode::Number(value))
    }

    fn string(&mut self) -> Result<String, String> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.position += 1;
        let mut output = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return self.syntax("unterminated string");
            };
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(output);
                }
                b'\\' => {
                    self.position += 1;
                    let escaped = self
                        .peek()
                        .ok_or_else(|| format!("unterminated escape at byte {}", self.position))?;
                    self.position += 1;
                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => {
                            let first = self.hex_quad()?;
                            if (0xd800..=0xdbff).contains(&first)
                                && self.bytes.get(self.position..self.position + 2) == Some(b"\\u")
                            {
                                self.position += 2;
                                let second = self.hex_quad()?;
                                if (0xdc00..=0xdfff).contains(&second) {
                                    let scalar = 0x10000
                                        + (((first as u32 - 0xd800) << 10)
                                            | (second as u32 - 0xdc00));
                                    output.push(
                                        char::from_u32(scalar).expect("valid JSON surrogate pair"),
                                    );
                                } else {
                                    output.push('\u{fffd}');
                                    output
                                        .push(char::from_u32(second as u32).unwrap_or('\u{fffd}'));
                                }
                            } else {
                                output.push(char::from_u32(first as u32).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return self.syntax("invalid string escape"),
                    }
                }
                0x00..=0x1f => return self.syntax("unescaped control character in string"),
                _ => {
                    let tail = std::str::from_utf8(&self.bytes[self.position..])
                        .map_err(|_| format!("invalid UTF-8 at byte {}", self.position))?;
                    let ch = tail.chars().next().expect("non-empty JSON input tail");
                    output.push(ch);
                    self.position += ch.len_utf8();
                }
            }
        }
    }

    fn hex_quad(&mut self) -> Result<u16, String> {
        let start = self.position;
        let end = start.saturating_add(4);
        let Some(bytes) = self.bytes.get(start..end) else {
            return self.syntax("incomplete unicode escape");
        };
        let spelling = std::str::from_utf8(bytes).expect("ASCII JSON unicode escape");
        let value = u16::from_str_radix(spelling, 16)
            .map_err(|_| format!("invalid unicode escape at byte {start}"))?;
        self.position = end;
        Ok(value)
    }

    fn keyword(&mut self, keyword: &[u8]) -> Result<(), String> {
        if self.bytes.get(self.position..self.position + keyword.len()) != Some(keyword) {
            return self.syntax("unexpected token");
        }
        self.position += keyword.len();
        Ok(())
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn take(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn syntax<T>(&self, message: &str) -> Result<T, String> {
        Err(format!("{message} at byte {}", self.position))
    }
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
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let scientific = format!("{value:e}");
        let (mantissa, exponent) = scientific
            .split_once('e')
            .expect("scriptc: Rust scientific number without an exponent");
        let exponent = exponent
            .parse::<i32>()
            .expect("scriptc: invalid Rust scientific exponent");
        return format!(
            "{mantissa}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        );
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
        assert_eq!(format_number(1e21), "1e+21");
        assert_eq!(format_number(1e-7), "1e-7");
        assert_eq!(format_number(1e-6), "0.000001");
        assert_eq!(format_number(0.1 + 0.2), "0.30000000000000004");
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
    fn string_case_conversion_handles_ascii() {
        let value = string("ScriptC 42");
        assert_eq!(string_to_lower_case(&value).as_ref(), "scriptc 42");
        assert_eq!(string_to_upper_case(&value).as_ref(), "SCRIPTC 42");
        assert!(string_includes(&value, &string("iptC"), 0.0));
        assert!(!string_includes(&value, &string("iptc"), 0.0));
    }

    #[test]
    fn scalar_json_stringification_escapes_strings_and_normalizes_non_finite_numbers() {
        assert_eq!(json_stringify(&f64::NAN).as_ref(), "null");
        assert_eq!(json_stringify(&f64::INFINITY).as_ref(), "null");
        assert_eq!(json_stringify(&-0.0).as_ref(), "0");
        assert_eq!(json_stringify(&true).as_ref(), "true");
        assert_eq!(
            json_stringify(&string("quote \" slash \\\n\t\u{0007}")).as_ref(),
            "\"quote \\\" slash \\\\\\n\\t\\u0007\""
        );
        assert_eq!(json_stringify(&string("héllo 😀")).as_ref(), "\"héllo 😀\"");
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
