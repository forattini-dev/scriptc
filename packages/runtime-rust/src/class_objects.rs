//! Owning identities and data descriptors for runtime-created class families.
//!
//! This storage does not itself evaluate classes, implement accessors or
//! construct instances. The compiler supplies code templates and captures.
use crate::{
    ClearEdges, DataDescriptor, DataProperty, DataPropertyTable, DefineDataError, Gc, HeapValue,
    PropertyKey, Trace, Tracer, WriteOwnDataResult,
};

pub type JsClassObject<V> = Gc<ClassObject<V>>;
pub type JsClassInstance<V> = Gc<ClassInstance<V>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClassWriteDataResult {
    Written,
    NonWritable,
    NotExtensible,
}

/// One allocation per evaluated class, even when its code template is shared.
/// Mutable lexical bindings must be supplied as owning cell handles in `V`;
/// copying a binding's current value would not preserve closure semantics.
pub struct ClassObject<V: HeapValue> {
    template: usize,
    parent: Option<JsClassObject<V>>,
    captures: Vec<V>,
    static_data: DataPropertyTable<V>,
    prototype_data: DataPropertyTable<V>,
}

/// Instance storage keeps the specific evaluated class, not only its template.
pub struct ClassInstance<V: HeapValue> {
    class: Option<JsClassObject<V>>,
    own_data: DataPropertyTable<V>,
}

impl<V: HeapValue> Trace for ClassInstance<V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(class) = &self.class {
            tracer.edge(class);
        }
        self.own_data
            .trace_values(|value| value.trace_value(tracer));
    }
}

impl<V: HeapValue> ClearEdges for ClassInstance<V> {
    fn clear_edges(&mut self) {
        self.class = None;
        self.own_data = DataPropertyTable::default();
    }
}

impl<V: HeapValue> Trace for ClassObject<V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(parent) = &self.parent {
            tracer.edge(parent);
        }
        for capture in &self.captures {
            capture.trace_value(tracer);
        }
        self.static_data
            .trace_values(|value| value.trace_value(tracer));
        self.prototype_data
            .trace_values(|value| value.trace_value(tracer));
    }
}

impl<V: HeapValue> ClearEdges for ClassObject<V> {
    fn clear_edges(&mut self) {
        self.parent = None;
        self.captures.clear();
        self.static_data = DataPropertyTable::default();
        self.prototype_data = DataPropertyTable::default();
    }
}

pub fn class_object_new<V: HeapValue>(
    template: usize,
    parent: Option<JsClassObject<V>>,
    captures: Vec<V>,
) -> JsClassObject<V> {
    Gc::new(ClassObject {
        template,
        parent,
        captures,
        static_data: DataPropertyTable::new(),
        prototype_data: DataPropertyTable::new(),
    })
}

pub fn class_object_template<V: HeapValue>(class: &JsClassObject<V>) -> usize {
    class.with(|data| data.template)
}

pub fn class_object_parent<V: HeapValue>(class: &JsClassObject<V>) -> Option<JsClassObject<V>> {
    class.with(|data| data.parent.clone())
}

pub fn class_object_capture<V: HeapValue>(class: &JsClassObject<V>, index: usize) -> Option<V> {
    class.with(|data| data.captures.get(index).cloned())
}

pub fn class_instance_new<V: HeapValue>(class: JsClassObject<V>) -> JsClassInstance<V> {
    Gc::new(ClassInstance {
        class: Some(class),
        own_data: DataPropertyTable::new(),
    })
}

pub fn class_instance_class<V: HeapValue>(
    instance: &JsClassInstance<V>,
) -> Option<JsClassObject<V>> {
    instance.with(|data| data.class.clone())
}

/// Ordinary class ancestry only; custom Symbol.hasInstance and prototype
/// replacement require their own frontend/runtime contract.
pub fn class_instance_of<V: HeapValue>(
    instance: &JsClassInstance<V>,
    constructor: &JsClassObject<V>,
) -> bool {
    let mut current = class_instance_class(instance);
    while let Some(class) = current {
        if class.ptr_eq(constructor) {
            return true;
        }
        current = class_object_parent(&class);
    }
    false
}

/// Define an own data property. Callers own extensibility and SameValue policy.
pub fn class_instance_define_data<V: HeapValue>(
    instance: &JsClassInstance<V>,
    key: PropertyKey,
    descriptor: &DataDescriptor<V>,
    extensible: bool,
    undefined: V,
    same_value: impl Fn(&V, &V) -> bool,
) -> Result<(), DefineDataError> {
    instance.with_mut(|data| {
        data.own_data
            .define(key, descriptor, extensible, undefined, same_value)
    })
}

/// Ordinary data-property assignment. Accessor setters and proxy traps are
/// outside this storage contract. The caller decides strict-mode errors.
pub fn class_instance_write_data<V: HeapValue>(
    instance: &JsClassInstance<V>,
    key: PropertyKey,
    value: V,
    extensible: bool,
    undefined: V,
) -> ClassWriteDataResult {
    let (result, class) = instance.with_mut(|data| {
        (
            data.own_data.write_own(&key, value.clone()),
            data.class.clone(),
        )
    });
    match result {
        WriteOwnDataResult::Written => return ClassWriteDataResult::Written,
        WriteOwnDataResult::NonWritable => return ClassWriteDataResult::NonWritable,
        WriteOwnDataResult::Missing => {}
    }
    if class
        .and_then(|class| class_object_lookup_data(&class, true, &key))
        .is_some_and(|(_, property)| !property.writable)
    {
        return ClassWriteDataResult::NonWritable;
    }
    if !extensible {
        return ClassWriteDataResult::NotExtensible;
    }
    let descriptor = DataDescriptor {
        value: Some(value),
        writable: Some(true),
        enumerable: Some(true),
        configurable: Some(true),
    };
    instance.with_mut(|data| {
        data.own_data
            .define(key, &descriptor, true, undefined, |_, _| false)
            .expect("new own data property")
    });
    ClassWriteDataResult::Written
}

/// A missing own property is deleted successfully, even if inherited.
pub fn class_instance_delete_data<V: HeapValue>(
    instance: &JsClassInstance<V>,
    key: &PropertyKey,
) -> bool {
    instance.with_mut(|data| data.own_data.delete(key))
}

pub fn class_instance_own_data_keys<V: HeapValue>(
    instance: &JsClassInstance<V>,
    enumerable_only: bool,
) -> Vec<PropertyKey> {
    instance.with(|data| data.own_data.own_keys(enumerable_only))
}

/// Own data shadows prototype data even when its value is undefined.
pub fn class_instance_lookup_data<V: HeapValue>(
    instance: &JsClassInstance<V>,
    key: &PropertyKey,
) -> Option<DataProperty<V>> {
    let (own, class) = instance.with(|data| (data.own_data.get(key).cloned(), data.class.clone()));
    own.or_else(|| {
        class.and_then(|class| class_object_lookup_data(&class, true, key).map(|(_, value)| value))
    })
}

/// The caller supplies the object's extensibility and JavaScript SameValue
/// policy; this storage does not implement preventExtensions or accessors.
pub fn class_object_define_data<V: HeapValue>(
    class: &JsClassObject<V>,
    prototype: bool,
    key: PropertyKey,
    descriptor: &DataDescriptor<V>,
    extensible: bool,
    undefined: V,
    same_value: impl Fn(&V, &V) -> bool,
) -> Result<(), DefineDataError> {
    class.with_mut(|data| {
        let table = if prototype {
            &mut data.prototype_data
        } else {
            &mut data.static_data
        };
        table.define(key, descriptor, extensible, undefined, same_value)
    })
}

/// Static assignment writes the receiver, while honoring inherited data
/// restrictions. Defining a static field uses `class_object_define_data`.
pub fn class_object_write_static_data<V: HeapValue>(
    class: &JsClassObject<V>,
    key: PropertyKey,
    value: V,
    extensible: bool,
    undefined: V,
) -> ClassWriteDataResult {
    let (result, parent) = class.with_mut(|data| {
        (
            data.static_data.write_own(&key, value.clone()),
            data.parent.clone(),
        )
    });
    match result {
        WriteOwnDataResult::Written => return ClassWriteDataResult::Written,
        WriteOwnDataResult::NonWritable => return ClassWriteDataResult::NonWritable,
        WriteOwnDataResult::Missing => {}
    }
    if parent
        .and_then(|parent| class_object_lookup_data(&parent, false, &key))
        .is_some_and(|(_, property)| !property.writable)
    {
        return ClassWriteDataResult::NonWritable;
    }
    if !extensible {
        return ClassWriteDataResult::NotExtensible;
    }
    let descriptor = DataDescriptor {
        value: Some(value),
        writable: Some(true),
        enumerable: Some(true),
        configurable: Some(true),
    };
    class.with_mut(|data| {
        data.static_data
            .define(key, &descriptor, true, undefined, |_, _| false)
            .expect("new own static data property")
    });
    ClassWriteDataResult::Written
}

pub fn class_object_delete_data<V: HeapValue>(
    class: &JsClassObject<V>,
    prototype: bool,
    key: &PropertyKey,
) -> bool {
    class.with_mut(|data| {
        let table = if prototype {
            &mut data.prototype_data
        } else {
            &mut data.static_data
        };
        table.delete(key)
    })
}

pub fn class_object_own_data_keys<V: HeapValue>(
    class: &JsClassObject<V>,
    prototype: bool,
    enumerable_only: bool,
) -> Vec<PropertyKey> {
    class.with(|data| {
        let table = if prototype {
            &data.prototype_data
        } else {
            &data.static_data
        };
        table.own_keys(enumerable_only)
    })
}

/// Walk the immutable class-parent chain without replacing symbol identity by
/// its description. Return the owner as well as the descriptor for dispatch.
pub fn class_object_lookup_data<V: HeapValue>(
    class: &JsClassObject<V>,
    prototype: bool,
    key: &PropertyKey,
) -> Option<(JsClassObject<V>, DataProperty<V>)> {
    let mut current = Some(class.clone());
    while let Some(owner) = current {
        let (property, parent) = owner.with(|data| {
            let table = if prototype {
                &data.prototype_data
            } else {
                &data.static_data
            };
            (table.get(key).cloned(), data.parent.clone())
        });
        if let Some(property) = property {
            return Some((owner, property));
        }
        current = parent;
    }
    None
}

#[cfg(test)]
#[path = "class_objects.test.rs"]
mod tests;
