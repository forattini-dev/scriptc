// A traced projection retains the typed array as its sole storage. Scalar
// accesses convert one element; they never clone the array or synchronize a
// mirror. Function pointers cannot hide untraced captures from the collector.
trait ArrayView<T: ArrayElement>: Trace {
    fn source(&self) -> &dyn std::any::Any;
    fn identity(&self) -> usize;
    fn raw(&self) -> Option<JsArray<T>>;
    fn regex_metadata(&self) -> Option<(f64, JsString)>;
    fn len(&self) -> f64;
    fn get(&self, index: f64) -> T;
    fn set(&self, index: f64, value: T);
    fn push(&self, value: T) -> f64;
    fn pop(&self) -> T;
    fn splice(&self, start: f64, count: f64, items: Vec<T>) -> Vec<T>;
    fn reverse(&self);
    fn fill(&self, value: T, start: f64, end: f64);
    fn copy_within(&self, target: f64, start: f64, end: f64);
}

struct MappedArray<S: ArrayElement, T: ArrayElement> {
    source: JsArray<S>,
    read: fn(S) -> T,
    write: fn(T) -> S,
}

impl<S: ArrayElement, T: ArrayElement> Trace for MappedArray<S, T> {
    fn trace(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.source); }
}

impl<S: ArrayElement, T: ArrayElement> ArrayView<T> for MappedArray<S, T> {
    fn source(&self) -> &dyn std::any::Any { &self.source }
    fn identity(&self) -> usize { array_identity(&self.source) }
    fn raw(&self) -> Option<JsArray<T>> {
        array_raw(&self.source).map(|source| array_mapped(source, self.read, self.write))
    }
    fn regex_metadata(&self) -> Option<(f64, JsString)> { array_regex_metadata(&self.source) }
    fn len(&self) -> f64 { array_len(&self.source) }
    fn get(&self, index: f64) -> T { (self.read)(array_get(&self.source, index)) }
    fn set(&self, index: f64, value: T) { array_set(&self.source, index, (self.write)(value)); }
    fn push(&self, value: T) -> f64 { array_push(&self.source, (self.write)(value)) }
    fn pop(&self) -> T { (self.read)(array_pop(&self.source)) }
    fn splice(&self, start: f64, count: f64, items: Vec<T>) -> Vec<T> {
        let items = items.into_iter().map(self.write).collect();
        let removed = array_splice_with_items(&self.source, start, count, items);
        array_values(&removed).into_iter().map(self.read).collect()
    }
    fn reverse(&self) { array_reverse(&self.source); }
    fn fill(&self, value: T, start: f64, end: f64) {
        array_fill(&self.source, (self.write)(value), start, end);
    }
    fn copy_within(&self, target: f64, start: f64, end: f64) {
        array_copy_within(&self.source, target, start, end);
    }
}

impl<T: ArrayElement> ArrayData<T> {
    // Borrow ordinary Vec storage; materialize only for bulk readers of a view.
    #[track_caller]
    fn elements(&self) -> std::borrow::Cow<'_, [T]> {
        self.require_dense("reading array values");
        match &self.view {
            None => std::borrow::Cow::Borrowed(&self.elements),
            Some(view) => std::borrow::Cow::Owned(
                (0..view.len() as usize).map(|index| view.get(index as f64)).collect(),
            ),
        }
    }
}

fn array_view<T: ArrayElement>(array: &JsArray<T>) -> Option<Rc<dyn ArrayView<T>>> {
    array.with(|data| data.view.clone())
}

pub fn array_identity<T: ArrayElement>(array: &JsArray<T>) -> usize {
    array.with(|data| data.view.as_ref().map_or_else(|| array.identity(), |view| view.identity()))
}

pub fn array_mapped<S: ArrayElement, T: ArrayElement>(
    source: JsArray<S>, read: fn(S) -> T, write: fn(T) -> S,
) -> JsArray<T> {
    Gc::new(ArrayData {
        elements: Vec::new(), auxiliary: None, sparse: None,
        view: Some(Rc::new(MappedArray { source, read, write })),
    })
}

/// Recover the original typed storage without decoding or copying its elements.
pub fn array_mapped_source<S: ArrayElement, T: ArrayElement>(array: &JsArray<T>) -> Option<JsArray<S>> {
    let direct: &dyn std::any::Any = array;
    array.with(|data| data.view.as_ref()?.source().downcast_ref::<JsArray<S>>().cloned())
        .or_else(|| direct.downcast_ref::<JsArray<S>>().cloned())
}

// Reuse the optional auxiliary slot: ordinary arrays pay no extra field
// for regex metadata, and typed/dynamic projections share its identity.
fn array_set_regex_metadata<T: ArrayElement>(array: &JsArray<T>, index: f64, input: JsString) {
    array.with_mut(|data| data.auxiliary = Some(Rc::new(ArrayAux::RegexMatch { index, input })));
}

pub fn array_regex_metadata<T: ArrayElement>(array: &JsArray<T>) -> Option<(f64, JsString)> {
    array.with(|data| match &data.view {
        Some(view) => view.regex_metadata(),
        None => match data.auxiliary.as_deref() {
            Some(ArrayAux::RegexMatch { index, input }) => Some((*index, input.clone())),
            _ => None,
        },
    })
}
