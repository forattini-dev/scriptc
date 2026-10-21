// Own data properties belong to the promise's object identity, independently
// of its settlement payload type. Storage is allocated only on first write or
// when publishing a representation view that must share future writes.
trait PromiseProperty: Any {
    fn value(&self) -> &dyn Any;
    fn trace_property(&self, tracer: &mut Tracer<'_>);
}

impl<V: HeapValue> PromiseProperty for V {
    fn value(&self) -> &dyn Any {
        self
    }
    fn trace_property(&self, tracer: &mut Tracer<'_>) {
        self.trace_value(tracer);
    }
}

struct PromiseProperties {
    entries: Vec<(String, Box<dyn PromiseProperty>)>,
}
impl Trace for PromiseProperties {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for (_, value) in &self.entries {
            value.trace_property(tracer);
        }
    }
}
impl ClearEdges for PromiseProperties {
    fn clear_edges(&mut self) {
        self.entries.clear();
    }
}

fn promise_properties<T: HeapValue>(promise: &JsPromise<T>) -> Gc<PromiseProperties> {
    promise.with_mut(|data| {
        data.own
            .get_or_insert_with(|| {
                Gc::new(PromiseProperties {
                    entries: Vec::new(),
                })
            })
            .clone()
    })
}

pub fn promise_own_set<T: HeapValue, V: HeapValue>(promise: &JsPromise<T>, key: &str, value: V) {
    promise_properties(promise).with_mut(|data| {
        let value: Box<dyn PromiseProperty> = Box::new(value);
        if let Some((_, slot)) = data.entries.iter_mut().find(|(name, _)| name == key) {
            *slot = value;
        } else {
            data.entries.push((key.to_owned(), value));
        }
    });
}

pub fn promise_own_get<T: HeapValue, V: HeapValue>(promise: &JsPromise<T>, key: &str) -> Option<V> {
    let own = promise.with(|data| data.own.clone())?;
    promise_properties_get(&own, key)
}

fn promise_properties_get<V: HeapValue>(own: &Gc<PromiseProperties>, key: &str) -> Option<V> {
    own.with(|data| {
        data.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| {
                value
                    .value()
                    .downcast_ref::<V>()
                    .cloned()
                    .unwrap_or_else(|| {
                        throw_type_error(
                            "scriptc: incompatible native Promise property view".to_owned(),
                        )
                    })
            })
    })
}

pub fn promise_handle_own_get<V: HeapValue>(handle: &JsPromiseHandle, key: &str) -> Option<V> {
    promise_properties_get(&handle.own, key)
}

pub fn promise_handle_own_keys(handle: &JsPromiseHandle) -> Vec<String> {
    handle
        .own
        .with(|data| data.entries.iter().map(|(name, _)| name.clone()).collect())
}

pub fn promise_own_keys<T: HeapValue>(promise: &JsPromise<T>) -> Vec<String> {
    promise.with(|data| {
        data.own
            .as_ref()
            .map(|own| own.with(|data| data.entries.iter().map(|(name, _)| name.clone()).collect()))
            .unwrap_or_default()
    })
}

pub fn promise_own_delete<T: HeapValue>(promise: &JsPromise<T>, key: &str) -> bool {
    if let Some(own) = promise.with(|data| data.own.clone()) {
        own.with_mut(|data| data.entries.retain(|(name, _)| name != key));
    }
    true
}
