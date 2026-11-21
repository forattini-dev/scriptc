//! Own-property operations with receiver-correct accessor dispatch.
use crate::{
    ClearEdges, DefineOrdinaryError, Gc, HeapValue, OrdinaryDescriptor, OrdinaryProperty,
    OrdinaryPropertyTable, OrdinaryWrite, PropertyKey, Trace, Tracer,
};

pub type JsOrdinaryObject<V> = Gc<OrdinaryObject<V>>;

/// Own properties only; prototype traversal and proxies are not implemented.
pub struct OrdinaryObject<V: HeapValue> {
    properties: OrdinaryPropertyTable<V>,
    extensible: bool,
}

impl<V: HeapValue> Trace for OrdinaryObject<V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        self.properties
            .trace_values(|value| value.trace_value(tracer));
    }
}

impl<V: HeapValue> ClearEdges for OrdinaryObject<V> {
    fn clear_edges(&mut self) {
        self.properties = OrdinaryPropertyTable::new();
    }
}

pub fn ordinary_object_new<V: HeapValue>() -> JsOrdinaryObject<V> {
    Gc::new(OrdinaryObject {
        properties: OrdinaryPropertyTable::new(),
        extensible: true,
    })
}

pub fn ordinary_object_prevent_extensions<V: HeapValue>(object: &JsOrdinaryObject<V>) {
    object.with_mut(|data| data.extensible = false);
}

/// Callers validate that accessor values are callable or undefined.
pub fn ordinary_object_define<V: HeapValue>(
    object: &JsOrdinaryObject<V>,
    key: PropertyKey,
    descriptor: &OrdinaryDescriptor<V>,
    undefined: V,
    same_value: impl Fn(&V, &V) -> bool,
) -> Result<(), DefineOrdinaryError> {
    object.with_mut(|data| {
        data.properties
            .define(key, descriptor, data.extensible, undefined, same_value)
    })
}

pub fn ordinary_object_own_descriptor<V: HeapValue>(
    object: &JsOrdinaryObject<V>,
    key: &PropertyKey,
) -> Option<OrdinaryProperty<V>> {
    object.with(|data| data.properties.get(key).cloned())
}

pub fn ordinary_object_own_keys<V: HeapValue>(
    object: &JsOrdinaryObject<V>,
    enumerable_only: bool,
) -> Vec<PropertyKey> {
    object.with(|data| data.properties.own_keys(enumerable_only))
}

pub fn ordinary_object_delete<V: HeapValue>(
    object: &JsOrdinaryObject<V>,
    key: &PropertyKey,
) -> bool {
    object.with_mut(|data| data.properties.delete(key))
}

/// Copy the descriptor before invoking user code, so a getter may re-enter,
/// mutate or delete properties on the original receiver.
pub fn ordinary_object_get<V: HeapValue>(
    object: &JsOrdinaryObject<V>,
    key: &PropertyKey,
    undefined: V,
    is_undefined: impl Fn(&V) -> bool,
    call_getter: impl FnOnce(V, JsOrdinaryObject<V>) -> V,
) -> V {
    match ordinary_object_own_descriptor(object, key) {
        Some(OrdinaryProperty::Data(property)) => property.value,
        Some(OrdinaryProperty::Accessor(property)) if !is_undefined(&property.get) => {
            call_getter(property.get, object.clone())
        }
        _ => undefined,
    }
}

/// Returns false for a getter-only property, frozen data or a non-extensible
/// object. The caller supplies strict-mode error handling and invokes setters.
pub fn ordinary_object_set<V: HeapValue>(
    object: &JsOrdinaryObject<V>,
    key: PropertyKey,
    value: V,
    undefined: V,
    is_undefined: impl Fn(&V) -> bool,
    call_setter: impl FnOnce(V, JsOrdinaryObject<V>, V),
) -> bool {
    let (result, extensible) = object.with_mut(|data| {
        (
            data.properties.write_own(&key, value.clone()),
            data.extensible,
        )
    });
    match result {
        OrdinaryWrite::Written => true,
        OrdinaryWrite::NonWritable => false,
        OrdinaryWrite::Setter(setter) if is_undefined(&setter) => false,
        OrdinaryWrite::Setter(setter) => {
            call_setter(setter, object.clone(), value);
            true
        }
        OrdinaryWrite::Missing if !extensible => false,
        OrdinaryWrite::Missing => {
            let descriptor = OrdinaryDescriptor {
                value: Some(value),
                writable: Some(true),
                enumerable: Some(true),
                configurable: Some(true),
                get: None,
                set: None,
            };
            object
                .with_mut(|data| {
                    data.properties
                        .define(key, &descriptor, data.extensible, undefined, |_, _| false)
                })
                .is_ok()
        }
    }
}

#[cfg(test)]
#[path = "ordinary_objects.test.rs"]
mod tests;
