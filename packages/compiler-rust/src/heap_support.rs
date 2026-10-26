// Typed owning edges used by generated records, maps and union elements.
trait NativeTrace {
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>);
}
struct NativeCell<T: NativeTrace + Clone + 'static> { value: Option<T> }
fn native_cell<T: NativeTrace + Clone + 'static>(value: T) -> runtime::Gc<NativeCell<T>> { runtime::Gc::new(NativeCell { value: Some(value) }) }
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
impl<T: runtime::Trace + runtime::ClearEdges + 'static> NativeTrace for runtime::Gc<T> {
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>) {
        tracer.edge(self);
    }
}
struct NativeMap<K: NativeTrace + 'static, V: NativeTrace + 'static> {
    null_prototype: bool,
    entries: Vec<(K, V)>,
}
impl<K: NativeTrace + 'static, V: NativeTrace + 'static> runtime::Trace for NativeMap<K, V> {
    fn trace(&self, tracer: &mut runtime::Tracer<'_>) {
        for (key, value) in &self.entries {
            key.trace_native(tracer);
            value.trace_native(tracer);
        }
    }
}
impl<K: NativeTrace + 'static, V: NativeTrace + 'static> runtime::ClearEdges for NativeMap<K, V> {
    fn clear_edges(&mut self) {
        self.entries.clear();
    }
}
