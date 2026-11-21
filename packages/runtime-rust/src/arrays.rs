/// A value that may be stored in a traced JavaScript array.
pub trait ArrayElement: Clone + 'static {
    fn trace_element(&self, _tracer: &mut Tracer<'_>) {}
}

pub trait JoinElement: ArrayElement {
    fn append_joined(&self, output: &mut JsStringBuilder);
}

impl ArrayElement for f64 {}
impl ArrayElement for bool {}
impl ArrayElement for usize {}
impl ArrayElement for JsString {}
impl ArrayElement for JsRegex {}
impl ArrayElement for JsSymbol {}

impl JoinElement for f64 {
    fn append_joined(&self, output: &mut JsStringBuilder) {
        output.push_str(&format_number(*self));
    }
}

impl JoinElement for bool {
    fn append_joined(&self, output: &mut JsStringBuilder) {
        output.push_str(if *self { "true" } else { "false" });
    }
}

impl JoinElement for JsString {
    fn append_joined(&self, output: &mut JsStringBuilder) {
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

enum ArrayAux<T: ArrayElement> {
    Raw(JsArray<T>),
    FrozenTemplate { raw: Option<JsArray<T>> },
    RegexMatch { index: f64, input: JsString, groups: Vec<(JsString, usize)> },
}

const ARRAY_HOLE: u8 = 0;
const ARRAY_VALUE: u8 = 1;
const ARRAY_UNDEFINED: u8 = 2;
/// Fill at most this many dense gap slots; farther values use sparse storage.
const ARRAY_DENSE_LIMIT: usize = 1 << 20;

/// Slot states of an array with holes, present-undefined slots, or a logical
/// length beyond its stored elements — the C lane's `ScrArr` states. Hole and
/// undefined slots inside `elements` keep a stale copy of a written value:
/// every read consults the state first, so that payload is never observed.
struct ArraySparse<T: ArrayElement> {
    length: usize,
    states: Vec<u8>,
    tail_undefined: std::collections::BTreeSet<usize>,
    tail_values: std::collections::BTreeMap<usize, T>,
}

pub struct ArrayData<T: ArrayElement> {
    elements: Vec<T>,
    auxiliary: Option<Rc<ArrayAux<T>>>,
    // `Box` keeps the common property-free array at its small size, matching
    // the `sparse` field below; a bare `Vec` would widen every `ArrayData`.
    #[allow(clippy::box_collection)]
    properties: Option<Box<Vec<(JsString, T)>>>,
    view: Option<Rc<dyn ArrayView<T>>>,
    sparse: Option<Box<ArraySparse<T>>>,
}

impl<T: ArrayElement> Trace for ArrayData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for element in &self.elements {
            element.trace_element(tracer);
        }
        if let Some(sparse) = &self.sparse { for value in sparse.tail_values.values() { value.trace_element(tracer); } }
        if let Some(view) = &self.view { view.trace(tracer); }
        if let Some(ArrayAux::Raw(raw) | ArrayAux::FrozenTemplate { raw: Some(raw) }) = self.auxiliary.as_deref() {
            tracer.edge(raw);
        }
        if let Some(properties) = &self.properties {
            for (_, value) in properties.iter() { value.trace_element(tracer); }
        }
    }
}

impl<T: ArrayElement> ClearEdges for ArrayData<T> {
    fn clear_edges(&mut self) {
        self.elements.clear();
        self.auxiliary = None;
        self.properties = None;
        self.view = None;
        self.sparse = None;
    }
}

impl<T: ArrayElement> ArrayData<T> {
    fn logical_len(&self) -> usize {
        self.sparse.as_ref().map_or(self.elements.len(), |sparse| sparse.length)
    }

    fn slot_state(&self, index: usize) -> u8 {
        match &self.sparse {
            None if index < self.elements.len() => ARRAY_VALUE,
            None => ARRAY_HOLE,
            Some(sparse) if index >= sparse.length => ARRAY_HOLE,
            Some(sparse) if index < sparse.states.len() => sparse.states[index],
            Some(sparse) if sparse.tail_values.contains_key(&index) => ARRAY_VALUE,
            Some(sparse) if sparse.tail_undefined.contains(&index) => ARRAY_UNDEFINED,
            Some(_) => ARRAY_HOLE,
        }
    }

    fn sparse_mut(&mut self) -> &mut ArraySparse<T> {
        let length = self.elements.len();
        self.sparse.get_or_insert_with(|| {
            Box::new(ArraySparse {
                length,
                states: vec![ARRAY_VALUE; length],
                tail_undefined: std::collections::BTreeSet::new(), tail_values: std::collections::BTreeMap::new(),
            })
        })
    }

    /// Drop the sparse bookkeeping once every stored slot is a value again and
    /// nothing lies past the stored elements.
    fn normalize_sparse(&mut self) {
        let dense = self.sparse.as_ref().is_some_and(|sparse| {
            sparse.length == self.elements.len()
                && sparse.tail_undefined.is_empty() && sparse.tail_values.is_empty()
                && sparse.states.iter().all(|state| *state == ARRAY_VALUE)
        });
        if dense {
            self.sparse = None;
        }
    }

    /// A holey array has no dense value sequence: operations that need one fail
    /// explicitly instead of observing a stale payload.
    #[track_caller]
    fn require_dense(&self, operation: &str) {
        if self.sparse.is_some() {
            let caller = std::panic::Location::caller();
            throw_error_code(
                format!(
                    "{operation} over an array with holes or undefined slots is not supported yet ({}:{})",
                    caller.file(),
                    caller.line()
                ),
                "SC3001",
            );
        }
    }
}

fn array_canonical_index(index: f64) -> usize {
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 || index > 4_294_967_294.0 {
        panic!("scriptc: invalid array index");
    }
    index as usize
}

pub type JsArray<T> = Gc<ArrayData<T>>;

pub struct ArrayIteratorData<T: ArrayElement> {
    array: Option<JsArray<T>>,
    index: usize,
    kind: ArrayIteratorKind,
}

#[derive(Clone, Copy)]
pub enum ArrayIteratorKind {
    Entries,
    Keys,
    Values,
}

pub enum ArrayIteratorItem<T: ArrayElement> {
    Entry(f64, T),
    Key(f64),
    Value(T),
}

impl<T: ArrayElement> Trace for ArrayIteratorData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(array) = &self.array {
            tracer.edge(array);
        }
    }
}

impl<T: ArrayElement> ClearEdges for ArrayIteratorData<T> {
    fn clear_edges(&mut self) {
        self.array = None;
    }
}

pub type JsArrayIterator<T> = Gc<ArrayIteratorData<T>>;

thread_local! {
    static TEMPLATE_STRINGS: RefCell<HashMap<String, JsArray<JsString>>> = RefCell::new(HashMap::new());
    static TEMPLATE_OBJECT_STORAGE: RefCell<HashMap<String, Box<dyn std::any::Any>>> = RefCell::new(HashMap::new());
    static TEMPLATE_FROZEN_MAY_EXIST: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn template_strings<S: JsStringSource>(key: &str, cooked: &[S]) -> JsArray<JsString> {
    TEMPLATE_STRINGS.with(|instances| {
        let mut instances = instances.borrow_mut();
        instances
            .entry(key.to_owned())
            .or_insert_with(|| array_new(cooked.iter().map(|value| string(value)).collect()))
            .clone()
    })
}

pub fn template_strings_clear() {
    TEMPLATE_STRINGS.with(|instances| instances.borrow_mut().clear());
    TEMPLATE_OBJECT_STORAGE.with(|instances| instances.borrow_mut().clear());
}

/// Retain the cooked and raw arrays for one syntactic template site.
///
/// This is storage infrastructure, not a complete JavaScript template object:
/// callers must implement property descriptors and strict/sloppy assignment
/// semantics before exposing these arrays to source code.
pub fn template_object_storage<T: ArrayElement>(
    key: &str,
    cooked: Vec<T>,
    raw: Vec<T>,
) -> JsArray<T> {
    assert_eq!(cooked.len(), raw.len(), "template raw/cooked length");
    TEMPLATE_FROZEN_MAY_EXIST.with(|flag| flag.set(true));
    TEMPLATE_OBJECT_STORAGE.with(|instances| {
        let mut instances = instances.borrow_mut();
        let stored = instances
            .entry(key.to_owned())
            .or_insert_with(|| {
                let raw = array_new(raw);
                raw.with_mut(|data| {
                    data.auxiliary = Some(Rc::new(ArrayAux::FrozenTemplate { raw: None }));
                });
                let cooked = array_new(cooked);
                cooked.with_mut(|data| {
                    data.auxiliary = Some(Rc::new(ArrayAux::FrozenTemplate { raw: Some(raw) }));
                });
                Box::new(cooked)
            });
        stored
            .downcast_ref::<JsArray<T>>()
            .expect("template site changed its native element type")
            .clone()
    })
}

/// `Object.freeze(array)`: every later mutation of this array (writes,
/// length changes, push/pop/splice and the other mutating methods) throws a
/// TypeError, exactly like the frozen template arrays sharing this
/// integrity marker. A cooked template keeps its raw companion.
pub fn array_freeze<T: ArrayElement>(array: &JsArray<T>) {
    TEMPLATE_FROZEN_MAY_EXIST.with(|flag| flag.set(true));
    if array.with(|data| data.view.is_some()) {
        throw_error_code(
            "scriptc SC1031: Object.freeze of a mapped array view requires native object integrity semantics".to_owned(),
            "SC1031",
        );
    }
    array.with_mut(|data| {
        let raw = match data.auxiliary.as_deref() {
            None => None,
            Some(ArrayAux::Raw(raw)) => Some(raw.clone()),
            Some(ArrayAux::FrozenTemplate { .. }) => return,
            Some(ArrayAux::RegexMatch { .. }) => throw_error_code(
                "scriptc SC1031: Object.freeze of a RegExp match array requires native object integrity semantics".to_owned(),
                "SC1031",
            ),
        };
        data.auxiliary = Some(Rc::new(ArrayAux::FrozenTemplate { raw }));
    });
}

pub fn array_new<T: ArrayElement>(elements: Vec<T>) -> JsArray<T> {
    Gc::new(ArrayData {
        elements,
        auxiliary: None,
        properties: None,
        view: None,
        sparse: None,
    })
}

pub fn array_new_with_raw<T: ArrayElement>(
    elements: Vec<T>,
    raw_elements: Vec<T>,
) -> JsArray<T> {
    let raw = array_new(raw_elements);
    Gc::new(ArrayData {
        elements,
        auxiliary: Some(Rc::new(ArrayAux::Raw(raw))),
        properties: None,
        view: None,
        sparse: None,
    })
}

pub fn array_raw<T: ArrayElement>(array: &JsArray<T>) -> Option<JsArray<T>> {
    array.with(|data| match &data.view { Some(view) => view.raw(), None => match data.auxiliary.as_deref() { Some(ArrayAux::Raw(raw) | ArrayAux::FrozenTemplate { raw: Some(raw) }) => Some(raw.clone()), _ => None } })
}

/// Whether this is one of the immutable internal template arrays, including
/// a mapped view of its original backing storage.
pub fn array_is_template_frozen<T: ArrayElement>(array: &JsArray<T>) -> bool {
    if !TEMPLATE_FROZEN_MAY_EXIST.with(|flag| flag.get()) { return false; }
    array.with(|data| match &data.view {
        Some(view) => view.is_template_frozen(),
        None => matches!(data.auxiliary.as_deref(), Some(ArrayAux::FrozenTemplate { .. })),
    })
}

/// A native array's own data-property value, including slots that are present
/// but have no typed payload and the template object's separate raw array.
pub enum ArrayOwnValue<T: ArrayElement> {
    Element(T),
    Undefined,
    Length(f64),
    Raw(JsArray<T>),
}

pub struct ArrayOwnDescriptor<T: ArrayElement> {
    pub value: ArrayOwnValue<T>,
    pub writable: bool,
    pub enumerable: bool,
    pub configurable: bool,
}

/// Inspect a represented own string key without invoking an element getter.
pub fn array_own_descriptor<T: ArrayElement>(
    array: &JsArray<T>,
    key: &JsString,
) -> Option<ArrayOwnDescriptor<T>> {
    let frozen = array_is_template_frozen(array);
    if key == "length" {
        return Some(ArrayOwnDescriptor {
            value: ArrayOwnValue::Length(array_len(array)),
            writable: !frozen,
            enumerable: false,
            configurable: false,
        });
    }
    if frozen && key == "raw" && let Some(raw) = array_raw(array) {
        return Some(ArrayOwnDescriptor {
            value: ArrayOwnValue::Raw(raw),
            writable: false,
            enumerable: false,
            configurable: false,
        });
    }
    if let Some(index) = key.well_formed_utf8().and_then(|key| {
        key.parse::<u32>().ok().filter(|index| *index != u32::MAX && key == index.to_string())
    }) {
        let value = match array_state(array, f64::from(index)) {
            1.0 => ArrayOwnValue::Element(array_get(array, f64::from(index))),
            2.0 => ArrayOwnValue::Undefined,
            _ => return None,
        };
        return Some(ArrayOwnDescriptor {
            value,
            writable: !frozen,
            enumerable: true,
            configurable: !frozen,
        });
    }
    array_property_get(array, key).map(|value| ArrayOwnDescriptor {
        value: ArrayOwnValue::Element(value),
        writable: !frozen,
        enumerable: true,
        configurable: !frozen,
    })
}

fn array_require_template_writable<T: ArrayElement>(array: &JsArray<T>) {
    if array_is_template_frozen(array) {
        throw_type_error("Cannot modify a frozen template array".to_owned());
    }
}

pub fn array_set_raw<T: ArrayElement>(array: &JsArray<T>, raw: JsArray<T>) {
    array_require_template_writable(array);
    array.with_mut(|data| data.auxiliary = Some(Rc::new(ArrayAux::Raw(raw))));
}

pub fn array_property_get<T: ArrayElement>(array: &JsArray<T>, key: &JsString) -> Option<T> {
    if let Some(view) = array_view(array) { return view.property_get(key); }
    array.with(|data| data.properties.as_ref().and_then(|properties|
        properties.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone())))
}

pub fn array_property_has<T: ArrayElement>(array: &JsArray<T>, key: &JsString) -> bool {
    if let Some(view) = array_view(array) { return view.property_has(key); }
    array.with(|data| data.properties.as_ref().is_some_and(|properties|
        properties.iter().any(|(name, _)| name == key)))
}

pub fn array_property_keys<T: ArrayElement>(array: &JsArray<T>) -> Vec<JsString> {
    if let Some(view) = array_view(array) { return view.property_keys(); }
    array.with(|data| {
        data.properties.as_ref().map_or_else(Vec::new, |properties| {
            properties.iter().map(|(name, _)| name.clone()).collect()
        })
    })
}

pub fn array_property_set<T: ArrayElement>(array: &JsArray<T>, key: JsString, value: T) {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { view.property_set(key, value); return; }
    array.with_mut(|data| {
        let properties = data.properties.get_or_insert_with(|| Box::new(Vec::new()));
        if let Some((_, current)) = properties.iter_mut().find(|(name, _)| name == &key) {
            *current = value;
        } else {
            properties.push((key, value));
        }
    });
}

pub fn array_len<T: ArrayElement>(array: &JsArray<T>) -> f64 {
    array.with(|data| data.view.as_ref().map_or(data.logical_len() as f64, |view| view.len()))
}

/// An index is present when it holds a value or an explicit undefined.
pub fn array_has<T: ArrayElement>(array: &JsArray<T>, index: f64) -> bool {
    if !(0.0..f64::from(u32::MAX)).contains(&index) || index.fract() != 0.0 {
        return array_property_has(array, &number_to_string(index));
    }
    if index < 0.0 || index.fract() != 0.0 || index.is_nan() || index >= array_len(array) {
        return false;
    }
    array_state(array, index) != f64::from(ARRAY_HOLE)
}

/// The IR's slot state: 0 hole/missing, 1 value, 2 present undefined.
pub fn array_state<T: ArrayElement>(array: &JsArray<T>, index: f64) -> f64 {
    if !(0.0..f64::from(u32::MAX)).contains(&index) || index.fract() != 0.0 {
        return if array_property_has(array, &number_to_string(index)) { f64::from(ARRAY_VALUE) } else { f64::from(ARRAY_HOLE) };
    }
    if index < 0.0 || index.fract() != 0.0 || index.is_nan() || index >= array_len(array) {
        return ARRAY_HOLE as f64;
    }
    array.with(|data| data.view.as_ref().map_or_else(|| f64::from(data.slot_state(index as usize)), |view| view.state(index)))
}



/// `array.length = n`: truncation drops elements; growth leaves holes.
pub fn array_set_length<T: ArrayElement>(array: &JsArray<T>, length: f64) {
    array_require_template_writable(array);
    if length.is_nan() || length < 0.0 || length.fract() != 0.0 || length > 4_294_967_295.0 {
        throw_range_error("Invalid array length".to_owned());
    }
    let len = array_len(array);
    if length == len { return; }
    if let Some(view) = array_view(array) {
        if length > len {
            throw_error_code("growing the length of an array view is not supported yet".to_owned(), "SC3001");
        }
        view.splice(length, len - length, Vec::new());
        return;
    }
    let length = length as usize;
    array.with_mut(|data| {
        if length < data.elements.len() {
            data.elements.truncate(length);
        }
        let sparse = data.sparse_mut();
        sparse.states.truncate(length);
        sparse.tail_undefined.retain(|index| *index < length);
        sparse.tail_values.retain(|index, _| *index < length);
        sparse.length = length;
        data.normalize_sparse();
    });
}

/// Store an explicit present `undefined` without shrinking the length.
pub fn array_set_undefined<T: ArrayElement>(array: &JsArray<T>, index: f64) {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) {
        view.set_undefined(index);
        return;
    }
    let index = array_canonical_index(index);
    array.with_mut(|data| {
        let stored = data.elements.len();
        let sparse = data.sparse_mut();
        sparse.tail_values.remove(&index);
        if index < stored {
            sparse.states[index] = ARRAY_UNDEFINED;
        } else {
            sparse.tail_undefined.insert(index);
        }
        sparse.length = sparse.length.max(index + 1);
    });
}

/// `delete a[i]`: the slot becomes a hole; the length is unchanged.
pub fn array_delete<T: ArrayElement>(array: &JsArray<T>, index: f64) {
    if !array_has(array, index) { return; }
    array_require_template_writable(array);
    if let Some(view) = array_view(array) {
        view.delete(index);
        return;
    }
    let index = index as usize;
    array.with_mut(|data| {
        let stored = data.elements.len();
        let sparse = data.sparse_mut();
        sparse.tail_values.remove(&index);
        if index < stored {
            sparse.states[index] = ARRAY_HOLE;
        } else {
            sparse.tail_undefined.remove(&index);
        }
    });
}

/// `array.with(i, undefined)`: a copy whose holes read as undefined (the
/// method reads every index), with index `i` set to undefined.
pub fn array_with_undefined<T: ArrayElement>(array: &JsArray<T>, index: f64) -> JsArray<T> {
    let length = array_len(array) as usize;
    let relative = if index.is_nan() { 0.0 } else { index.trunc() };
    let actual = if relative >= 0.0 { relative } else { length as f64 + relative };
    if actual.is_nan() || actual < 0.0 || actual >= length as f64 {
        throw_range_error(format!("Invalid index : {}", format_number(index)));
    }
    let copy = array.with(|data| {
        if data.view.is_some() {
            throw_error_code("array.with(index, undefined) on an array view is not supported yet".to_owned(), "SC3001");
        }
        let mut sparse = ArraySparse {
            length,
            states: data.sparse.as_ref().map_or_else(|| vec![ARRAY_VALUE; data.elements.len()], |sparse| sparse.states.clone()),
            tail_undefined: std::collections::BTreeSet::new(), tail_values: std::collections::BTreeMap::new(),
        };
        for state in sparse.states.iter_mut() {
            if *state == ARRAY_HOLE {
                *state = ARRAY_UNDEFINED;
            }
        }
        if length - sparse.states.len() > ARRAY_DENSE_LIMIT {
            throw_error_code("array.with over a huge sparse array is not supported yet".to_owned(), "SC3001");
        }
        sparse.tail_undefined.extend(sparse.states.len()..length);
        Gc::new(ArrayData { elements: data.elements.clone(), auxiliary: None, properties: None, view: None, sparse: Some(Box::new(sparse)) })
    });
    array_set_undefined(&copy, actual);
    copy
}

pub fn array_values<T: ArrayElement>(array: &JsArray<T>) -> Vec<T> {
    array.with(|data| data.elements().into_owned())
}

pub fn array_iterator_new<T: ArrayElement>(
    array: &JsArray<T>,
    kind: ArrayIteratorKind,
) -> JsArrayIterator<T> {
    Gc::new(ArrayIteratorData {
        array: Some(array.clone()),
        index: 0,
        kind,
    })
}

pub fn array_iterator_next<T: ArrayElement>(
    iterator: &JsArrayIterator<T>,
) -> Option<ArrayIteratorItem<T>> {
    iterator.with_mut(|state| {
        let array = state.array.as_ref()?;
        if state.index >= array_len(array) as usize {
            state.array = None;
            return None;
        }
        let index = state.index as f64;
        state.index += 1;
        Some(match state.kind {
            ArrayIteratorKind::Entries => {
                ArrayIteratorItem::Entry(index, array_get(array, index))
            }
            ArrayIteratorKind::Keys => ArrayIteratorItem::Key(index),
            ArrayIteratorKind::Values => ArrayIteratorItem::Value(array_get(array, index)),
        })
    })
}

/// Advance an array iterator while representing holes and explicit undefined
/// with the caller's dynamic absence value. Typed iterators can continue to
/// use `array_iterator_next` when every element has a represented payload.
pub fn array_iterator_next_or<T: ArrayElement>(
    iterator: &JsArrayIterator<T>,
    absent: T,
) -> Option<ArrayIteratorItem<T>> {
    iterator.with_mut(|state| {
        let array = state.array.as_ref()?;
        if state.index >= array_len(array) as usize {
            state.array = None;
            return None;
        }
        let index = state.index as f64;
        state.index += 1;
        let value = || {
            if array_state(array, index) == 1.0 {
                array_get(array, index)
            } else {
                absent.clone()
            }
        };
        Some(match state.kind {
            ArrayIteratorKind::Entries => ArrayIteratorItem::Entry(index, value()),
            ArrayIteratorKind::Keys => ArrayIteratorItem::Key(index),
            ArrayIteratorKind::Values => ArrayIteratorItem::Value(value()),
        })
    })
}



pub fn array_push<T: ArrayElement>(array: &JsArray<T>, value: T) -> f64 {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { return view.push(value); }
    if array.with(|data| data.sparse.is_some()) {
        let length = array_len(array);
        array_set(array, length, value);
        return length + 1.0;
    }
    array.with_mut(|data| {
        data.elements.push(value);
        data.elements.len() as f64
    })
}

pub fn array_extend<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { for value in array_values(source) { view.push(value); } return view.len(); }
    let snapshot = source.with(|data| data.elements().into_owned());
    array.with_mut(|data| {
        data.require_dense("array.push(...spread)");
        data.elements.extend(snapshot);
        data.elements.len() as f64
    })
}

/// Push the source's observed values: holes become present undefined. Snapshot
/// before writing so `array.push(...array)` does not visit appended elements.
pub fn array_push_from<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    if array.with(|data| data.sparse.is_none()) && source.with(|data| data.sparse.is_none()) {
        return array_extend(array, source);
    }
    let slots = if array_view(source).is_some() {
        array_values(source).into_iter().map(Some).collect()
    } else {
        source.with(array_slots)
    };
    array_require_template_writable(array);
    if array_view(array).is_some() && slots.iter().any(Option::is_none) {
        throw_error_code("pushing undefined into an array view is not supported yet".to_owned(), "SC3001");
    }
    for slot in slots {
        match slot {
            Some(value) => { array_push(array, value); }
            None => array_set_undefined(array, array_len(array)),
        }
    }
    array_len(array)
}

pub fn array_unshift<T: ArrayElement>(array: &JsArray<T>, mut values: Vec<T>) -> f64 {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { view.splice(0.0, 0.0, values); return view.len(); }
    array.with_mut(|data| {
        data.require_dense("array.unshift");
        values.append(&mut data.elements);
        data.elements = values;
        data.elements.len() as f64
    })
}

pub fn array_unshift_from<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    let snapshot = source.with(|data| data.elements().into_owned());
    array_unshift(array, snapshot)
}

pub fn array_reverse<T: ArrayElement>(array: &JsArray<T>) -> JsArray<T> {
    if array_is_template_frozen(array) && array_len(array) > 1.0 { array_require_template_writable(array); }
    if let Some(view) = array_view(array) { view.reverse(); return array.clone(); }
    array.with_mut(|data| {
        data.require_dense("array.reverse");
        data.elements.reverse();
    });
    array.clone()
}

pub fn array_fill<T: ArrayElement>(
    array: &JsArray<T>,
    value: T,
    start: f64,
    end: f64,
) -> JsArray<T> {
    if array_is_template_frozen(array) {
        let length = array_len(array) as usize;
        if array_relative_index(start, length) < array_relative_index(end, length) {
            array_require_template_writable(array);
        }
    }
    if let Some(view) = array_view(array) { view.fill(value, start, end); return array.clone(); }
    array.with_mut(|data| {
        let length = data.logical_len();
        let start = array_relative_index(start, length);
        let end = array_relative_index(end, length).max(start);
        if start == end {
            return;
        }
        let stored = data.elements.len();
        if data.sparse.is_none() {
            data.elements[start..end].fill(value);
            return;
        }
        let prefix_end = end.min(stored);
        if start < prefix_end {
            data.elements[start..prefix_end].fill(value.clone());
            data.sparse.as_mut().expect("sparse array").states[start..prefix_end]
                .fill(ARRAY_VALUE);
        }
        let tail_start = start.max(stored);
        if tail_start < end {
            let sparse = data.sparse.as_mut().expect("sparse array");
            if tail_start - stored <= ARRAY_DENSE_LIMIT {
                for index in stored..end {
                    let filled = index >= tail_start;
                    let previous = sparse.tail_values.remove(&index);
                    let undefined = sparse.tail_undefined.remove(&index);
                    let state = if filled || previous.is_some() {
                        ARRAY_VALUE
                    } else if undefined {
                        ARRAY_UNDEFINED
                    } else {
                        ARRAY_HOLE
                    };
                    data.elements.push(if filled {
                        value.clone()
                    } else {
                        previous.unwrap_or_else(|| value.clone())
                    });
                    sparse.states.push(state);
                }
            } else {
                for index in tail_start..end {
                    sparse.tail_undefined.remove(&index);
                    sparse.tail_values.insert(index, value.clone());
                }
            }
        }
        data.normalize_sparse();
    });
    array.clone()
}

pub fn array_copy_within<T: ArrayElement>(
    array: &JsArray<T>,
    target: f64,
    start: f64,
    end: f64,
) -> JsArray<T> {
    if array_is_template_frozen(array) {
        let length = array_len(array) as usize;
        let target_index = array_relative_index(target, length);
        let start_index = array_relative_index(start, length);
        let end_index = array_relative_index(end, length).max(start_index);
        if (end_index - start_index).min(length - target_index) > 0 {
            array_require_template_writable(array);
        }
    }
    if let Some(view) = array_view(array) { view.copy_within(target, start, end); return array.clone(); }
    array.with_mut(|data| {
        data.require_dense("array.copyWithin");
        let length = data.elements.len();
        let target = array_relative_index(target, length);
        let start = array_relative_index(start, length);
        let end = array_relative_index(end, length).max(start);
        let count = (end - start).min(length - target);
        let copied = data.elements[start..start + count].to_vec();
        for (destination, value) in data.elements[target..target + count]
            .iter_mut()
            .zip(copied)
        {
            *destination = value;
        }
    });
    array.clone()
}

pub fn array_sort_by_snapshot<T, F>(array: &JsArray<T>, mut compare: F) -> JsArray<T>
where
    T: ArrayElement,
    F: FnMut(&T, &T) -> std::cmp::Ordering,
{
    // Snapshot only present entries: comparison callbacks may mutate the
    // original array. Undefined values are never passed to the comparator,
    // and holes remain absent after the defined values and undefined slots.
    let length = array_len(array);
    if length <= 1.0 && array_is_template_frozen(array) { return array.clone(); }
    let mut elements = Vec::new();
    let mut undefined = 0usize;
    let mut index = array_next_present(array, 0.0);
    while index < length {
        if array_state(array, index) == f64::from(ARRAY_UNDEFINED) {
            undefined += 1;
        } else {
            elements.push(array_get(array, index));
        }
        index = array_next_present(array, index + 1.0);
    }
    elements.sort_by(|left, right| compare(left, right));
    let mut destination = 0.0;
    for value in elements {
        array_set(array, destination, value);
        destination += 1.0;
    }
    for _ in 0..undefined {
        array_set_undefined(array, destination);
        destination += 1.0;
    }
    let mut index = array_next_present(array, destination);
    while index < length && index < array_len(array) {
        array_delete(array, index);
        index = array_next_present(array, index + 1.0);
    }
    array.clone()
}

fn array_relative_index(index: f64, length: usize) -> usize {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if index == f64::NEG_INFINITY {
        return 0;
    }
    if index == f64::INFINITY {
        return length;
    }
    if index < 0.0 {
        (length as f64 + index).clamp(0.0, length as f64) as usize
    } else {
        index.clamp(0.0, length as f64) as usize
    }
}

fn array_delete_count(delete_count: f64, available: usize) -> usize {
    if delete_count.is_nan() || delete_count <= 0.0 {
        0
    } else if delete_count == f64::INFINITY {
        available
    } else {
        delete_count.trunc().min(available as f64) as usize
    }
}



pub fn array_splice<T: ArrayElement>(
    array: &JsArray<T>,
    start: f64,
    delete_count: f64,
) -> JsArray<T> {
    array_splice_with_items(array, start, delete_count, Vec::new())
}

pub fn array_splice_with_items<T: ArrayElement>(
    array: &JsArray<T>,
    start: f64,
    delete_count: f64,
    items: Vec<T>,
) -> JsArray<T> {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { return array_new(view.splice(start, delete_count, items)); }
    let removed = array.with_mut(|data| {
        data.require_dense("array.splice");
        let start = array_relative_index(start, data.elements.len());
        let available = data.elements.len() - start;
        let delete_count = array_delete_count(delete_count, available);
        data.elements
            .splice(start..start + delete_count, items)
            .collect::<Vec<_>>()
    });
    array_new(removed)
}

/// Remove the first slot while retaining holes and explicit undefined in the
/// remaining indices. The returned None represents both an absent first slot
/// and an explicit undefined; the mutation preserves their distinction.
pub fn array_shift_optional<T: ArrayElement>(array: &JsArray<T>) -> Option<T> {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { return view.shift_optional(); }
    array.with_mut(|data| {
        if data.logical_len() == 0 { return None; }
        let first = (data.slot_state(0) == ARRAY_VALUE)
            .then(|| data.stored_value(0).expect("scriptc: present array payload").clone());
        if !data.elements.is_empty() { data.elements.remove(0); }
        if let Some(sparse) = data.sparse.as_mut() {
            if !sparse.states.is_empty() { sparse.states.remove(0); }
            sparse.tail_values = std::mem::take(&mut sparse.tail_values).into_iter()
                .filter_map(|(index, value)| index.checked_sub(1).map(|index| (index, value)))
                .collect();
            sparse.tail_undefined = std::mem::take(&mut sparse.tail_undefined).into_iter()
                .filter_map(|index| index.checked_sub(1)).collect();
            sparse.length -= 1;
        }
        data.normalize_sparse();
        first
    })
}

pub fn array_shift<T: ArrayElement>(array: &JsArray<T>) -> T {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { return view.splice(0.0, 1.0, Vec::new()).into_iter().next().expect("scriptc: array index out of bounds"); }
    array.with_mut(|data| {
        data.require_dense("array.shift");
        if data.elements.is_empty() {
            panic!("scriptc: array index out of bounds");
        }
        data.elements.remove(0)
    })
}

/// Every slot of a holey array as read by the copying methods (`toReversed`,
/// `toSpliced`, `with`): holes and explicit undefined both read as undefined.
fn array_slots<T: ArrayElement>(data: &ArrayData<T>) -> Vec<Option<T>> {
    let length = data.logical_len();
    if length - data.elements.len().min(length) > ARRAY_DENSE_LIMIT {
        throw_error_code("copying a huge sparse array is not supported yet".to_owned(), "SC3001");
    }
    (0..length)
        .map(|index| (data.slot_state(index) == ARRAY_VALUE).then(|| data.stored_value(index).expect("scriptc: present array payload").clone()))
        .collect()
}

/// A fresh array from slots, where `None` is a present undefined slot.
fn array_from_slots<T: ArrayElement>(slots: Vec<Option<T>>) -> JsArray<T> {
    let Some(placeholder) = slots.iter().flatten().next().cloned() else {
        let length = slots.len();
        return Gc::new(ArrayData {
            elements: Vec::new(),
            auxiliary: None,
            properties: None,
            view: None,
            sparse: Some(Box::new(ArraySparse { length, states: Vec::new(), tail_undefined: (0..length).collect(), tail_values: std::collections::BTreeMap::new() })),
        });
    };
    if slots.iter().all(Option::is_some) {
        return array_new(slots.into_iter().flatten().collect());
    }
    let states = slots.iter().map(|slot| if slot.is_some() { ARRAY_VALUE } else { ARRAY_UNDEFINED }).collect();
    let length = slots.len();
    let elements = slots.into_iter().map(|slot| slot.unwrap_or_else(|| placeholder.clone())).collect();
    Gc::new(ArrayData {
        elements,
        auxiliary: None,
        properties: None,
        view: None,
        sparse: Some(Box::new(ArraySparse { length, states, tail_undefined: std::collections::BTreeSet::new(), tail_values: std::collections::BTreeMap::new() })),
    })
}

pub fn array_to_reversed<T: ArrayElement>(array: &JsArray<T>) -> JsArray<T> {
    if let Some(mut slots) = array.with(|data| (data.sparse.is_some() && data.view.is_none()).then(|| array_slots(data))) {
        slots.reverse();
        return array_from_slots(slots);
    }
    let mut elements = array.with(|data| data.elements().into_owned());
    elements.reverse();
    array_new(elements)
}

pub fn array_to_spliced<T: ArrayElement>(
    array: &JsArray<T>,
    start: f64,
    delete_count: f64,
    items: &JsArray<T>,
) -> JsArray<T> {
    let holey = |candidate: &JsArray<T>| candidate.with(|data| data.sparse.is_some() && data.view.is_none());
    if holey(array) || holey(items) {
        let mut slots = array.with(|data| if data.view.is_none() { array_slots(data) } else { data.elements().iter().cloned().map(Some).collect() });
        let inserted = items.with(|data| if data.view.is_none() { array_slots(data) } else { data.elements().iter().cloned().map(Some).collect() });
        let start = array_relative_index(start, slots.len());
        let delete_count = array_delete_count(delete_count, slots.len() - start);
        slots.splice(start..start + delete_count, inserted);
        return array_from_slots(slots);
    }
    let source = array.with(|data| data.elements().into_owned());
    let items = items.with(|data| data.elements().into_owned());
    let start = array_relative_index(start, source.len());
    let delete_count = array_delete_count(delete_count, source.len() - start);
    let capacity = (source.len() - delete_count)
        .checked_add(items.len())
        .expect("scriptc: out of memory");
    let mut elements = Vec::with_capacity(capacity);
    elements.extend_from_slice(&source[..start]);
    elements.extend(items);
    elements.extend_from_slice(&source[start + delete_count..]);
    array_new(elements)
}

pub fn array_with<T: ArrayElement>(array: &JsArray<T>, index: f64, value: T) -> JsArray<T> {
    let length = array_len(array) as usize;
    let relative = if index.is_nan() { 0.0 } else { index.trunc() };
    let actual = if relative >= 0.0 {
        relative
    } else {
        length as f64 + relative
    };
    if actual.is_nan() || actual < 0.0 || actual >= length as f64 {
        throw_range_error(format!("Invalid index : {}", format_number(index)));
    }
    if let Some(mut slots) = array.with(|data| (data.sparse.is_some() && data.view.is_none()).then(|| array_slots(data))) {
        slots[actual as usize] = Some(value);
        return array_from_slots(slots);
    }
    let mut elements = array.with(|data| data.elements().into_owned());
    elements[actual as usize] = value;
    array_new(elements)
}

pub fn array_index_of_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> f64
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array_index_of_from_by(array, needle, 0.0, equal)
}

pub fn array_index_of_from_by<T, F>(
    array: &JsArray<T>,
    needle: &T,
    from_index: f64,
    equal: F,
) -> f64
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| {
        if data.sparse.is_some() && data.view.is_none() {
            // A typed needle never matches a hole or an explicit undefined slot.
            let start = array_relative_index(from_index, data.logical_len());
            let dense = (start..data.elements.len())
                .find(|index| data.slot_state(*index) == ARRAY_VALUE && equal(&data.elements[*index], needle))
                .map(|index| index as f64);
            return dense.or_else(|| data.sparse.as_ref()?.tail_values.range(start..)
                .find(|(_, value)| equal(value, needle)).map(|(index, _)| *index as f64)).unwrap_or(-1.0);
        }
        let elements = data.elements();
        let start = array_relative_index(from_index, elements.len());
        elements[start..]
            .iter()
            .position(|element| equal(element, needle))
            .map_or(-1.0, |index| (start + index) as f64)
    })
}

pub fn array_includes_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> bool
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| {
        if data.sparse.is_some() && data.view.is_none() {
            return (0..data.elements.len())
                .any(|index| data.slot_state(index) == ARRAY_VALUE && equal(&data.elements[index], needle)) ||
                data.sparse.as_ref().is_some_and(|sparse| sparse.tail_values.values().any(|value| equal(value, needle)));
        }
        data.elements().iter().any(|element| equal(element, needle))
    })
}

/// Join over a holey array: holes and explicit undefined slots contribute an
/// empty string, like Node; `append` renders each present value.
fn array_join_holey<T: ArrayElement>(
    data: &ArrayData<T>,
    separator: &JsString,
    append: impl Fn(&T, &mut JsStringBuilder),
) -> JsString {
    let mut output = JsStringBuilder::new();
    for index in 0..data.logical_len() {
        if index > 0 {
            output.push_str(separator);
        }
        if data.slot_state(index) == ARRAY_VALUE {
            append(data.stored_value(index).expect("scriptc: present array payload"), &mut output);
        }
    }
    output.finish()
}

pub fn array_join<T: JoinElement>(array: &JsArray<T>, separator: &JsString) -> JsString {
    if array_view(array).is_some() {
        return array_join_by(array, separator, |element, output| element.append_joined(output));
    }
    array.with(|data| {
        if data.sparse.is_some() && data.view.is_none() {
            return array_join_holey(data, separator, |element, output| element.append_joined(output));
        }
        let mut output = JsStringBuilder::new();
        for (index, element) in data.elements().iter().enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            element.append_joined(&mut output);
        }
        output.finish()
    })
}

pub fn array_join_by<T, F>(array: &JsArray<T>, separator: &JsString, append: F) -> JsString
where
    T: ArrayElement,
    F: Fn(&T, &mut JsStringBuilder),
{
    if array_view(array).is_some() {
        let length = array_len(array) as usize;
        let mut output = JsStringBuilder::new();
        for index in 0..length {
            if index > 0 { output.push_str(separator); }
            if array_state(array, index as f64) == f64::from(ARRAY_VALUE) {
                append(&array_get(array, index as f64), &mut output);
            }
        }
        return output.finish();
    }
    array.with(|data| {
        if data.sparse.is_some() && data.view.is_none() {
            return array_join_holey(data, separator, &append);
        }
        let mut output = JsStringBuilder::new();
        for (index, element) in data.elements().iter().enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            append(element, &mut output);
        }
        output.finish()
    })
}

pub fn array_pop<T: ArrayElement>(array: &JsArray<T>) -> T {
    array_require_template_writable(array);
    if let Some(view) = array_view(array) { return view.pop(); }
    if array.with(|data| data.sparse.is_some()) {
        let length = array_len(array);
        if length == 0.0 { panic!("scriptc: array index out of bounds"); }
        let last = array_get(array, length - 1.0);
        array_set_length(array, length - 1.0);
        return last;
    }
    array
        .with_mut(|data| data.elements.pop())
        .expect("scriptc: array index out of bounds")
}

pub fn array_ptr_eq<T: ArrayElement>(left: &JsArray<T>, right: &JsArray<T>) -> bool {
    array_identity(left) == array_identity(right)
}
