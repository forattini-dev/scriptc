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
    RegexMatch { index: f64, input: JsString },
}

pub struct ArrayData<T: ArrayElement> {
    elements: Vec<T>,
    auxiliary: Option<Rc<ArrayAux<T>>>,
    view: Option<Rc<dyn ArrayView<T>>>,
}

impl<T: ArrayElement> Trace for ArrayData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for element in &self.elements {
            element.trace_element(tracer);
        }
        if let Some(view) = &self.view { view.trace(tracer); }
        if let Some(ArrayAux::Raw(raw)) = self.auxiliary.as_deref() { tracer.edge(raw); }
    }
}

impl<T: ArrayElement> ClearEdges for ArrayData<T> {
    fn clear_edges(&mut self) {
        self.elements.clear();
        self.auxiliary = None;
        self.view = None;
    }
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
}

pub fn array_new<T: ArrayElement>(elements: Vec<T>) -> JsArray<T> {
    Gc::new(ArrayData {
        elements,
        auxiliary: None,
        view: None,
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
        view: None,
    })
}

pub fn array_raw<T: ArrayElement>(array: &JsArray<T>) -> Option<JsArray<T>> {
    array.with(|data| match &data.view { Some(view) => view.raw(), None => match data.auxiliary.as_deref() { Some(ArrayAux::Raw(raw)) => Some(raw.clone()), _ => None } })
}

pub fn array_set_raw<T: ArrayElement>(array: &JsArray<T>, raw: JsArray<T>) {
    array.with_mut(|data| data.auxiliary = Some(Rc::new(ArrayAux::Raw(raw))));
}

pub fn array_len<T: ArrayElement>(array: &JsArray<T>) -> f64 {
    array.with(|data| data.view.as_ref().map_or(data.elements.len() as f64, |view| view.len()))
}

pub fn array_get<T: ArrayElement>(array: &JsArray<T>, index: f64) -> T {
    let index = array_index(index, false, array_len(array) as usize);
    array.with(|data| data.view.as_ref().map_or_else(|| data.elements[index].clone(), |view| view.get(index as f64)))
}

/// Native arrays are dense: an index is present exactly when it is a
/// canonical array index below the length.
pub fn array_has<T: ArrayElement>(array: &JsArray<T>, index: f64) -> bool {
    index >= 0.0 && index.fract() == 0.0 && index < array_len(array)
}

/// The IR's slot state: 0 hole/missing, 1 value (dense arrays have no
/// separately stored undefined state).
pub fn array_state<T: ArrayElement>(array: &JsArray<T>, index: f64) -> f64 {
    if array_has(array, index) { 1.0 } else { 0.0 }
}

pub fn array_next_present<T: ArrayElement>(array: &JsArray<T>, start: f64) -> f64 {
    let len = array_len(array);
    if start.is_nan() || start >= len { return len; }
    if start > 0.0 { start.ceil() } else { 0.0 }
}

/// `array.length = n`: truncation matches JavaScript; growth would create
/// holes, which dense native arrays do not represent.
pub fn array_set_length<T: ArrayElement>(array: &JsArray<T>, length: f64) {
    if length.is_nan() || length < 0.0 || length.fract() != 0.0 || length > 4_294_967_295.0 {
        throw_range_error("Invalid array length".to_owned());
    }
    let len = array_len(array);
    if length > len {
        throw_error_code("growing an array length creates sparse holes, which native Rust arrays do not support yet".to_owned(), "SC3001");
    }
    if length == len { return; }
    if let Some(view) = array_view(array) { view.splice(length, len - length, Vec::new()); return; }
    array.with_mut(|data| data.elements.truncate(length as usize));
}

pub fn array_set_undefined<T: ArrayElement>(_array: &JsArray<T>, _index: f64) {
    throw_error_code("storing undefined in a non-optional native array slot is not supported yet".to_owned(), "SC3001");
}

pub fn array_delete<T: ArrayElement>(array: &JsArray<T>, index: f64) {
    if !array_has(array, index) { return; }
    throw_error_code("deleting an array element creates a sparse hole, which native Rust arrays do not support yet".to_owned(), "SC3001");
}

pub fn array_with_undefined<T: ArrayElement>(_array: &JsArray<T>, _index: f64) -> JsArray<T> {
    throw_error_code("array.with(index, undefined) on a non-optional native array is not supported yet".to_owned(), "SC3001");
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

pub fn array_set<T: ArrayElement>(array: &JsArray<T>, index: f64, value: T) {
    if let Some(view) = array_view(array) { view.set(index, value); return; }
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
    if let Some(view) = array_view(array) { return view.push(value); }
    array.with_mut(|data| {
        data.elements.push(value);
        data.elements.len() as f64
    })
}

pub fn array_extend<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    if let Some(view) = array_view(array) { for value in array_values(source) { view.push(value); } return view.len(); }
    let snapshot = source.with(|data| data.elements().into_owned());
    array.with_mut(|data| {
        data.elements.extend(snapshot);
        data.elements.len() as f64
    })
}

pub fn array_unshift<T: ArrayElement>(array: &JsArray<T>, mut values: Vec<T>) -> f64 {
    if let Some(view) = array_view(array) { view.splice(0.0, 0.0, values); return view.len(); }
    array.with_mut(|data| {
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
    if let Some(view) = array_view(array) { view.reverse(); return array.clone(); }
    array.with_mut(|data| data.elements.reverse());
    array.clone()
}

pub fn array_fill<T: ArrayElement>(
    array: &JsArray<T>,
    value: T,
    start: f64,
    end: f64,
) -> JsArray<T> {
    if let Some(view) = array_view(array) { view.fill(value, start, end); return array.clone(); }
    array.with_mut(|data| {
        let start = array_relative_index(start, data.elements.len());
        let end = array_relative_index(end, data.elements.len()).max(start);
        data.elements[start..end].fill(value);
    });
    array.clone()
}

pub fn array_copy_within<T: ArrayElement>(
    array: &JsArray<T>,
    target: f64,
    start: f64,
    end: f64,
) -> JsArray<T> {
    if let Some(view) = array_view(array) { view.copy_within(target, start, end); return array.clone(); }
    array.with_mut(|data| {
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
    let mut elements = array.with(|data| data.elements().into_owned());
    elements.sort_by(|left, right| compare(left, right));
    if let Some(view) = array_view(array) {
        for (index, value) in elements.into_iter().take(view.len() as usize).enumerate() { view.set(index as f64, value); }
        return array.clone();
    }
    array.with_mut(|data| {
        for (stored, sorted) in data.elements.iter_mut().zip(elements) {
            *stored = sorted;
        }
    });
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

pub fn array_slice<T: ArrayElement>(array: &JsArray<T>, start: f64, end: f64) -> JsArray<T> {
    let elements = array.with(|data| {
        let elements = data.elements();
        let start = array_relative_index(start, elements.len());
        let end = array_relative_index(end, elements.len()).max(start);
        elements[start..end].to_vec()
    });
    array_new(elements)
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
    if let Some(view) = array_view(array) { return array_new(view.splice(start, delete_count, items)); }
    let removed = array.with_mut(|data| {
        let start = array_relative_index(start, data.elements.len());
        let available = data.elements.len() - start;
        let delete_count = array_delete_count(delete_count, available);
        data.elements
            .splice(start..start + delete_count, items)
            .collect::<Vec<_>>()
    });
    array_new(removed)
}

pub fn array_shift<T: ArrayElement>(array: &JsArray<T>) -> T {
    if let Some(view) = array_view(array) { return view.splice(0.0, 1.0, Vec::new()).into_iter().next().expect("scriptc: array index out of bounds"); }
    array.with_mut(|data| {
        if data.elements.is_empty() {
            panic!("scriptc: array index out of bounds");
        }
        data.elements.remove(0)
    })
}

pub fn array_to_reversed<T: ArrayElement>(array: &JsArray<T>) -> JsArray<T> {
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
    array.with(|data| data.elements().iter().any(|element| equal(element, needle)))
}

pub fn array_join<T: JoinElement>(array: &JsArray<T>, separator: &JsString) -> JsString {
    array.with(|data| {
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
    array.with(|data| {
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
    if let Some(view) = array_view(array) { return view.pop(); }
    array
        .with_mut(|data| data.elements.pop())
        .expect("scriptc: array index out of bounds")
}

pub fn array_ptr_eq<T: ArrayElement>(left: &JsArray<T>, right: &JsArray<T>) -> bool {
    array_identity(left) == array_identity(right)
}
