// Typed owning edges used by generated records, maps and union elements.
trait NativeTrace {
    fn trace_native(&self, tracer: &mut runtime::Tracer<'_>);
}
impl NativeTrace for f64 {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for bool {
    fn trace_native(&self, _: &mut runtime::Tracer<'_>) {}
}
impl NativeTrace for String {
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
