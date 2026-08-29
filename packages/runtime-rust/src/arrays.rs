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
impl ArrayElement for JsRegex {}
impl ArrayElement for JsSymbol {}

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
    raw: Option<JsArray<T>>,
}

impl<T: ArrayElement> Trace for ArrayData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for element in &self.elements {
            element.trace_element(tracer);
        }
        if let Some(raw) = &self.raw {
            tracer.edge(raw);
        }
    }
}

impl<T: ArrayElement> ClearEdges for ArrayData<T> {
    fn clear_edges(&mut self) {
        self.elements.clear();
        self.raw = None;
    }
}

pub type JsArray<T> = Gc<ArrayData<T>>;

thread_local! {
    static TEMPLATE_STRINGS: RefCell<HashMap<String, JsArray<JsString>>> = RefCell::new(HashMap::new());
}

pub fn template_strings(key: &str, cooked: &[&str]) -> JsArray<JsString> {
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
        raw: None,
    })
}

pub fn array_new_with_raw<T: ArrayElement>(
    elements: Vec<T>,
    raw_elements: Vec<T>,
) -> JsArray<T> {
    let raw = array_new(raw_elements);
    Gc::new(ArrayData {
        elements,
        raw: Some(raw),
    })
}

pub fn array_raw<T: ArrayElement>(array: &JsArray<T>) -> Option<JsArray<T>> {
    array.with(|data| data.raw.clone())
}

pub fn array_set_raw<T: ArrayElement>(array: &JsArray<T>, raw: JsArray<T>) {
    array.with_mut(|data| data.raw = Some(raw));
}

pub fn array_len<T: ArrayElement>(array: &JsArray<T>) -> f64 {
    array.with(|data| data.elements.len() as f64)
}

pub fn array_get<T: ArrayElement>(array: &JsArray<T>, index: f64) -> T {
    let index = array_index(index, false, array_len(array) as usize);
    array.with(|data| data.elements[index].clone())
}

pub fn array_values<T: ArrayElement>(array: &JsArray<T>) -> Vec<T> {
    array.with(|data| data.elements.clone())
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

pub fn array_unshift<T: ArrayElement>(array: &JsArray<T>, mut values: Vec<T>) -> f64 {
    array.with_mut(|data| {
        values.append(&mut data.elements);
        data.elements = values;
        data.elements.len() as f64
    })
}

pub fn array_unshift_from<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    let snapshot = source.with(|data| data.elements.clone());
    array_unshift(array, snapshot)
}

pub fn array_reverse<T: ArrayElement>(array: &JsArray<T>) -> JsArray<T> {
    array.with_mut(|data| data.elements.reverse());
    array.clone()
}

pub fn array_sort_by_snapshot<T, F>(array: &JsArray<T>, mut compare: F) -> JsArray<T>
where
    T: ArrayElement,
    F: FnMut(&T, &T) -> std::cmp::Ordering,
{
    let mut elements = array.with(|data| data.elements.clone());
    elements.sort_by(|left, right| compare(left, right));
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
        let start = array_relative_index(start, data.elements.len());
        let end = array_relative_index(end, data.elements.len()).max(start);
        data.elements[start..end].to_vec()
    });
    array_new(elements)
}

pub fn array_splice<T: ArrayElement>(
    array: &JsArray<T>,
    start: f64,
    delete_count: f64,
) -> JsArray<T> {
    let removed = array.with_mut(|data| {
        let start = array_relative_index(start, data.elements.len());
        let available = data.elements.len() - start;
        let delete_count = array_delete_count(delete_count, available);
        data.elements
            .drain(start..start + delete_count)
            .collect::<Vec<_>>()
    });
    array_new(removed)
}

pub fn array_shift<T: ArrayElement>(array: &JsArray<T>) -> T {
    array.with_mut(|data| {
        if data.elements.is_empty() {
            panic!("scriptc: array index out of bounds");
        }
        data.elements.remove(0)
    })
}

pub fn array_to_reversed<T: ArrayElement>(array: &JsArray<T>) -> JsArray<T> {
    let mut elements = array.with(|data| data.elements.clone());
    elements.reverse();
    array_new(elements)
}

pub fn array_to_spliced<T: ArrayElement>(
    array: &JsArray<T>,
    start: f64,
    delete_count: f64,
    items: &JsArray<T>,
) -> JsArray<T> {
    let source = array.with(|data| data.elements.clone());
    let items = items.with(|data| data.elements.clone());
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
    let length = array.with(|data| data.elements.len());
    let relative = if index.is_nan() { 0.0 } else { index.trunc() };
    let actual = if relative >= 0.0 {
        relative
    } else {
        length as f64 + relative
    };
    if !(actual >= 0.0) || actual >= length as f64 {
        throw_range_error(format!("Invalid index : {}", format_number(index)));
    }
    let mut elements = array.with(|data| data.elements.clone());
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
        let start = array_relative_index(from_index, data.elements.len());
        data.elements[start..]
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

pub fn array_join_by<T, F>(array: &JsArray<T>, separator: &JsString, append: F) -> JsString
where
    T: ArrayElement,
    F: Fn(&T, &mut String),
{
    array.with(|data| {
        let mut output = String::new();
        for (index, element) in data.elements.iter().enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            append(element, &mut output);
        }
        Rc::from(output)
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
