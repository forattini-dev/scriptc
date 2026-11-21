// Typed owning edges used by generated records, maps and union elements.
trait NativeTrace {
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>);
}
struct NativeCell<T: NativeTrace + Clone + 'static> { value: Option<T>, lexical_name: Option<&'static str> }
fn native_cell<T: NativeTrace + Clone + 'static>(value: T) -> runtime::Gc<NativeCell<T>> { runtime::Gc::new(NativeCell { value: Some(value), lexical_name: None }) }
fn native_lexical_cell<T: NativeTrace + Clone + 'static>(name: &'static str) -> runtime::Gc<NativeCell<T>> { runtime::Gc::new(NativeCell { value: None, lexical_name: Some(name) }) }
fn native_cell_read<T: NativeTrace + Clone + 'static>(cell: &runtime::Gc<NativeCell<T>>) -> T { cell.with(|cell| match &cell.value { Some(value) => value.clone(), None => match cell.lexical_name { Some(name) => runtime::throw_reference_error(format!("Cannot access '{name}' before initialization")), None => panic!("scriptc: cleared lexical cell") } }) }
fn native_cell_write<T: NativeTrace + Clone + 'static>(cell: &runtime::Gc<NativeCell<T>>, value: T) { cell.with_mut(|cell| { if cell.value.is_none() { if let Some(name) = cell.lexical_name { runtime::throw_reference_error(format!("Cannot access '{name}' before initialization")); } } cell.value = Some(value); }); }
impl<T: NativeTrace + Clone + 'static> runtime::Trace for NativeCell<T> {
    fn trace(&self, tracer: &mut runtime::Tracer<'_>) { if let Some(value) = &self.value { value.trace_native(tracer); } }
}
impl<T: NativeTrace + Clone + 'static> runtime::ClearEdges for NativeCell<T> {
    fn clear_edges(&mut self) { self.value = None; }
}
impl NativeTrace for f64 {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for bool {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for runtime::JsString {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for runtime::JsBigInt {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for runtime::JsSymbol {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for runtime::JsRegex {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for runtime::FsDirent {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl<T: runtime::Trace + runtime::ClearEdges + 'static> NativeTrace for runtime::Gc<T> {
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {
        tracer.edge(self);
    }
}
impl<Y: runtime::HeapValue, R: runtime::HeapValue, N: runtime::HeapValue> NativeTrace
    for runtime::JsGenerator<Y, R, N>
{
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {
        runtime::HeapValue::trace_value(self, tracer);
    }
}
impl<Y: runtime::HeapValue, R: runtime::HeapValue, N: runtime::HeapValue> NativeTrace
    for runtime::JsAsyncGenerator<Y, R, N>
{
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {
        runtime::HeapValue::trace_value(self, tracer);
    }
}
struct NativeMap<K: NativeTrace + 'static, V: NativeTrace + 'static> {
    null_prototype: bool,
    entries: Vec<(K, V)>,
    hash_index: NativeHashIndex,
    symbol_properties: Option<runtime::DataPropertyTable<V>>,
}

// Typed Map views share one value-erased backing store. JavaScript Maps may
// acquire values outside an earlier TypeScript/JSDoc view; each native view
// checks reads and boxes writes without copying or splitting object identity.
struct NativeTypedMap<K: NativeTrace + 'static, V: 'static> {
    storage: runtime::Gc<NativeMap<K, NativeValue>>,
    read: fn(&NativeValue) -> V,
    write: fn(V) -> NativeValue,
}
impl<K: NativeTrace + 'static, V: 'static> Clone for NativeTypedMap<K, V> {
    fn clone(&self) -> Self {
        Self { storage: self.storage.clone(), read: self.read, write: self.write }
    }
}
impl<K: NativeTrace + 'static, V: 'static> NativeTypedMap<K, V> {
    fn ptr_eq<T: 'static>(&self, other: &NativeTypedMap<K, T>) -> bool {
        self.storage.ptr_eq(&other.storage)
    }
}
impl<K: NativeTrace + 'static, V: 'static> NativeTrace for NativeTypedMap<K, V> {
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {
        self.storage.trace_native(tracer);
    }
}
// A Set's element type is only a view of its JavaScript owner. Values entering
// through an erased iterable or another view retain their original identities.
struct NativeTypedSet<V: 'static> {
    storage: runtime::Gc<NativeMap<NativeValue, bool>>,
    read: fn(&NativeValue) -> V,
    write: fn(V) -> NativeValue,
}
impl<V: 'static> Clone for NativeTypedSet<V> {
    fn clone(&self) -> Self {
        Self { storage: self.storage.clone(), read: self.read, write: self.write }
    }
}
impl<V: 'static> NativeTypedSet<V> {
    fn ptr_eq<T: 'static>(&self, other: &NativeTypedSet<T>) -> bool {
        self.storage.ptr_eq(&other.storage)
    }
    fn identity(&self) -> usize { self.storage.identity() }
}
impl<V: 'static> NativeTrace for NativeTypedSet<V> {
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {
        self.storage.trace_native(tracer);
    }
}
impl<V: 'static> runtime::HeapValue for NativeTypedSet<V> {
    fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { self.trace_native(tracer); }
}
impl<V: 'static> runtime::ArrayElement for NativeTypedSet<V> {
    fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { self.trace_native(tracer); }
}
impl<K: NativeTrace + 'static, V: NativeTrace + 'static> runtime::Trace for NativeMap<K, V> {
    fn trace(&self, tracer: &mut runtime::Tracer<'_>) {
        for (key, value) in &self.entries {
            key.trace_native(tracer);
            value.trace_native(tracer);
        }
        if let Some(properties) = &self.symbol_properties {
            properties.trace_values(|value| value.trace_native(tracer));
        }
    }
}
impl<K: NativeTrace + 'static, V: NativeTrace + 'static> runtime::ClearEdges for NativeMap<K, V> {
    fn clear_edges(&mut self) {
        self.entries.clear();
        self.hash_index.clear();
        self.symbol_properties = None;
    }
}
