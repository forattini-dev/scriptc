use super::*;
use crate::{cell_get, cell_new, cell_set, collect_cycles, string, symbol_new};

#[derive(Clone)]
enum Value {
    Undefined,
    Number(f64),
    Class(JsClassObject<Value>),
    Instance(JsClassInstance<Value>),
}

impl HeapValue for Value {
    fn trace_value(&self, tracer: &mut Tracer<'_>) {
        match self {
            Self::Class(class) => tracer.edge(class),
            Self::Instance(instance) => tracer.edge(instance),
            _ => {}
        }
    }
}

fn descriptor(value: Value) -> DataDescriptor<Value> {
    DataDescriptor {
        value: Some(value),
        writable: Some(true),
        enumerable: Some(false),
        configurable: Some(true),
    }
}

fn define(class: &JsClassObject<Value>, prototype: bool, key: PropertyKey, value: Value) {
    class_object_define_data(
        class,
        prototype,
        key,
        &descriptor(value),
        true,
        Value::Undefined,
        |a, b| match (a, b) {
            (Value::Undefined, Value::Undefined) => true,
            (Value::Number(a), Value::Number(b)) => a.to_bits() == b.to_bits(),
            (Value::Class(a), Value::Class(b)) => a.ptr_eq(b),
            (Value::Instance(a), Value::Instance(b)) => a.ptr_eq(b),
            _ => false,
        },
    )
    .unwrap();
}

#[test]
fn repeated_factory_evaluations_keep_distinct_identities_and_captures() {
    let first = class_object_new(9, None, vec![Value::Number(1.0)]);
    let second = class_object_new(9, None, vec![Value::Number(2.0)]);
    let alias = first.clone();
    assert!(first.ptr_eq(&alias));
    assert!(!first.ptr_eq(&second));
    assert_eq!(
        class_object_template(&first),
        class_object_template(&second)
    );
    assert!(matches!(
        class_object_capture(&first, 0),
        Some(Value::Number(1.0))
    ));
    assert!(matches!(
        class_object_capture(&second, 0),
        Some(Value::Number(2.0))
    ));
    assert!(class_object_capture(&first, 1).is_none());
}

#[test]
fn chained_class_factories_preserve_heritage_and_static_overrides() {
    let base = class_object_new(1, None, vec![]);
    let plugin = class_object_new(2, Some(base.clone()), vec![Value::Class(base.clone())]);
    let configured = class_object_new(3, Some(plugin.clone()), vec![Value::Class(plugin.clone())]);
    let other = class_object_new(2, Some(base.clone()), vec![Value::Class(base.clone())]);
    let key = PropertyKey::String(string("plugins"));
    define(&base, false, key.clone(), Value::Number(1.0));
    define(&plugin, false, key.clone(), Value::Number(2.0));
    assert!(
        matches!(class_object_capture(&configured, 0), Some(Value::Class(c)) if c.ptr_eq(&plugin))
    );
    assert!(
        matches!(class_object_lookup_data(&configured, false, &key), Some((owner, property)) if owner.ptr_eq(&plugin) && matches!(property.value, Value::Number(2.0)))
    );
    let instance = class_instance_new(configured);
    assert!(class_instance_of(&instance, &plugin));
    assert!(class_instance_of(&instance, &base));
    assert!(!class_instance_of(&instance, &other));
}

#[test]
fn captures_can_share_live_lexical_binding_cells() {
    let binding = cell_new(1.0);
    let weak = binding.downgrade();
    let first = class_object_new(9, None, vec![binding.clone()]);
    let second = class_object_new(9, None, vec![binding.clone()]);
    cell_set(&binding, 7.0);
    drop(binding);
    assert_eq!(cell_get(&class_object_capture(&first, 0).unwrap()), 7.0);
    assert_eq!(cell_get(&class_object_capture(&second, 0).unwrap()), 7.0);
    drop(first);
    drop(second);
    collect_cycles();
    assert!(weak.upgrade().is_none());
}

#[test]
fn prototype_symbols_follow_identity_and_inheritance_without_becoming_static() {
    let first = symbol_new(&string("dispose"));
    let other = symbol_new(&string("dispose"));
    let key = PropertyKey::Symbol(first.clone());
    let other_key = PropertyKey::Symbol(other);
    let base = class_object_new(1, None, vec![]);
    let child = class_object_new(2, Some(base.clone()), vec![]);
    define(&base, true, key.clone(), Value::Number(11.0));
    define(&base, true, other_key.clone(), Value::Number(12.0));
    let (owner, inherited) = class_object_lookup_data(&child, true, &key).unwrap();
    assert!(owner.ptr_eq(&base));
    assert!(matches!(inherited.value, Value::Number(11.0)));
    assert!(!inherited.enumerable && inherited.writable && inherited.configurable);
    assert!(class_object_lookup_data(&child, false, &key).is_none());
    define(&child, true, key.clone(), Value::Number(21.0));
    assert!(
        class_object_lookup_data(&child, true, &key)
            .unwrap()
            .0
            .ptr_eq(&child)
    );
    assert!(matches!(
        class_object_lookup_data(&child, true, &other_key)
            .unwrap()
            .1
            .value,
        Value::Number(12.0)
    ));
    assert!(class_object_parent(&child).unwrap().ptr_eq(&base));
    assert!(class_object_own_data_keys(&base, true, true).is_empty());
    assert_eq!(class_object_own_data_keys(&base, true, false).len(), 2);
    assert!(class_object_delete_data(&base, true, &key));
    assert!(
        class_object_lookup_data(&child, true, &key)
            .unwrap()
            .0
            .ptr_eq(&child)
    );
    assert!(class_object_delete_data(&child, true, &key));
    assert!(class_object_lookup_data(&child, true, &key).is_none());
    assert!(class_object_lookup_data(&child, true, &other_key).is_some());
}

#[test]
fn prototype_presence_distinguishes_undefined_from_absence() {
    let present = PropertyKey::Symbol(symbol_new(&string("same")));
    let missing = PropertyKey::Symbol(symbol_new(&string("same")));
    let class = class_object_new(1, None, vec![]);
    define(&class, true, present.clone(), Value::Undefined);
    assert!(matches!(
        class_object_lookup_data(&class, true, &present)
            .unwrap()
            .1
            .value,
        Value::Undefined
    ));
    assert!(class_object_lookup_data(&class, true, &missing).is_none());
}

#[test]
fn factory_instances_keep_evaluated_class_identity_and_symbol_prototype() {
    let first = class_object_new(7, None, vec![]);
    let second = class_object_new(7, None, vec![]);
    let child = class_object_new(8, Some(first.clone()), vec![]);
    let instance = class_instance_new(child.clone());
    assert!(class_instance_of(&instance, &child));
    assert!(class_instance_of(&instance, &first));
    assert!(!class_instance_of(&instance, &second));
    assert!(class_instance_class(&instance).unwrap().ptr_eq(&child));

    let key = PropertyKey::Symbol(symbol_new(&string("dispose")));
    let other = PropertyKey::Symbol(symbol_new(&string("dispose")));
    define(&first, true, key.clone(), Value::Number(3.0));
    assert!(matches!(
        class_instance_lookup_data(&instance, &key).unwrap().value,
        Value::Number(3.0)
    ));
    assert!(class_instance_lookup_data(&instance, &other).is_none());
    class_instance_define_data(
        &instance,
        key.clone(),
        &descriptor(Value::Undefined),
        true,
        Value::Undefined,
        |_, _| false,
    )
    .unwrap();
    assert!(matches!(
        class_instance_lookup_data(&instance, &key).unwrap().value,
        Value::Undefined
    ));
    assert!(matches!(
        class_object_lookup_data(&first, true, &key)
            .unwrap()
            .1
            .value,
        Value::Number(3.0)
    ));
}

#[test]
fn instance_writes_shadow_inherited_data_and_delete_reveals_it() {
    let class = class_object_new(1, None, vec![]);
    let key = PropertyKey::Symbol(symbol_new(&string("method")));
    define(&class, true, key.clone(), Value::Number(1.0));
    let first = class_instance_new(class.clone());
    let second = class_instance_new(class.clone());
    assert_eq!(
        class_instance_write_data(
            &first,
            key.clone(),
            Value::Number(2.0),
            true,
            Value::Undefined
        ),
        ClassWriteDataResult::Written
    );
    assert!(matches!(
        class_instance_lookup_data(&first, &key).unwrap().value,
        Value::Number(2.0)
    ));
    assert!(matches!(
        class_instance_lookup_data(&second, &key).unwrap().value,
        Value::Number(1.0)
    ));
    let keys = class_instance_own_data_keys(&first, true);
    assert_eq!(keys.len(), 1);
    assert!(keys[0] == key);
    assert!(class_instance_delete_data(&first, &key));
    assert!(matches!(
        class_instance_lookup_data(&first, &key).unwrap().value,
        Value::Number(1.0)
    ));
    assert!(class_instance_own_data_keys(&first, true).is_empty());
    assert!(class_instance_delete_data(&first, &key));
}

#[test]
fn instance_writes_respect_nonwritable_and_nonextensible_data() {
    let class = class_object_new(1, None, vec![]);
    let key = PropertyKey::Symbol(symbol_new(&string("locked")));
    let locked = DataDescriptor {
        value: Some(Value::Number(1.0)),
        writable: Some(false),
        enumerable: Some(false),
        configurable: Some(false),
    };
    class_object_define_data(
        &class,
        true,
        key.clone(),
        &locked,
        true,
        Value::Undefined,
        |_, _| false,
    )
    .unwrap();
    let instance = class_instance_new(class);
    assert_eq!(
        class_instance_write_data(
            &instance,
            key.clone(),
            Value::Number(2.0),
            true,
            Value::Undefined
        ),
        ClassWriteDataResult::NonWritable
    );
    assert!(class_instance_own_data_keys(&instance, false).is_empty());
    let new_key = PropertyKey::String(string("new"));
    assert_eq!(
        class_instance_write_data(
            &instance,
            new_key.clone(),
            Value::Number(2.0),
            false,
            Value::Undefined
        ),
        ClassWriteDataResult::NotExtensible
    );
    assert!(class_instance_lookup_data(&instance, &new_key).is_none());
    class_instance_define_data(
        &instance,
        new_key.clone(),
        &locked,
        true,
        Value::Undefined,
        |_, _| false,
    )
    .unwrap();
    assert_eq!(
        class_instance_write_data(
            &instance,
            new_key.clone(),
            Value::Number(2.0),
            true,
            Value::Undefined
        ),
        ClassWriteDataResult::NonWritable
    );
    assert!(!class_instance_delete_data(&instance, &new_key));
}

#[test]
fn static_writes_keep_the_dynamic_receiver_and_field_definition_is_distinct() {
    let base = class_object_new(1, None, vec![]);
    let child = class_object_new(2, Some(base.clone()), vec![]);
    let sibling = class_object_new(2, Some(base.clone()), vec![]);
    let plugins = PropertyKey::String(string("plugins"));
    define(&base, false, plugins.clone(), Value::Number(1.0));
    assert_eq!(
        class_object_write_static_data(
            &child,
            plugins.clone(),
            Value::Number(2.0),
            true,
            Value::Undefined
        ),
        ClassWriteDataResult::Written
    );
    assert!(matches!(
        class_object_lookup_data(&child, false, &plugins)
            .unwrap()
            .1
            .value,
        Value::Number(2.0)
    ));
    assert!(matches!(
        class_object_lookup_data(&base, false, &plugins)
            .unwrap()
            .1
            .value,
        Value::Number(1.0)
    ));
    assert!(matches!(
        class_object_lookup_data(&sibling, false, &plugins)
            .unwrap()
            .1
            .value,
        Value::Number(1.0)
    ));
    assert_eq!(
        class_object_write_static_data(
            &child,
            plugins.clone(),
            Value::Number(3.0),
            false,
            Value::Undefined
        ),
        ClassWriteDataResult::Written
    );

    let locked = PropertyKey::String(string("locked"));
    let descriptor = DataDescriptor {
        value: Some(Value::Number(4.0)),
        writable: Some(false),
        enumerable: Some(false),
        configurable: Some(false),
    };
    class_object_define_data(
        &base,
        false,
        locked.clone(),
        &descriptor,
        true,
        Value::Undefined,
        |_, _| false,
    )
    .unwrap();
    assert_eq!(
        class_object_write_static_data(
            &child,
            locked.clone(),
            Value::Number(5.0),
            true,
            Value::Undefined
        ),
        ClassWriteDataResult::NonWritable
    );
    // Class field definition uses DefineOwnProperty, not inherited assignment.
    define(&child, false, locked.clone(), Value::Number(6.0));
    assert!(matches!(
        class_object_lookup_data(&child, false, &locked)
            .unwrap()
            .1
            .value,
        Value::Number(6.0)
    ));
    assert!(matches!(
        class_object_lookup_data(&base, false, &locked)
            .unwrap()
            .1
            .value,
        Value::Number(4.0)
    ));
}

#[test]
fn instance_own_data_cycles_are_collected() {
    let class = class_object_new(1, None, vec![]);
    let instance = class_instance_new(class);
    let weak = instance.downgrade();
    assert_eq!(
        class_instance_write_data(
            &instance,
            PropertyKey::String(string("self")),
            Value::Instance(instance.clone()),
            true,
            Value::Undefined
        ),
        ClassWriteDataResult::Written
    );
    drop(instance);
    collect_cycles();
    assert!(weak.upgrade().is_none());
}

#[test]
fn instance_and_class_cycles_are_traced_and_collected() {
    let class = class_object_new(1, None, vec![]);
    let instance = class_instance_new(class.clone());
    let weak_class = class.downgrade();
    let weak_instance = instance.downgrade();
    define(
        &class,
        false,
        PropertyKey::String(string("instance")),
        Value::Instance(instance.clone()),
    );
    drop(class);
    collect_cycles();
    assert!(
        weak_class.upgrade().is_some(),
        "the external instance keeps its class alive"
    );
    drop(instance);
    collect_cycles();
    assert!(weak_class.upgrade().is_none());
    assert!(weak_instance.upgrade().is_none());
}

#[test]
fn class_data_redefinition_keeps_nonconfigurable_invariants() {
    let class = class_object_new(1, None, vec![]);
    let key = PropertyKey::String(string("locked"));
    let locked = DataDescriptor {
        value: Some(Value::Number(1.0)),
        writable: Some(false),
        enumerable: Some(false),
        configurable: Some(false),
    };
    let same = |a: &Value, b: &Value| matches!((a, b), (Value::Number(x), Value::Number(y)) if x.to_bits() == y.to_bits());
    class_object_define_data(
        &class,
        true,
        key.clone(),
        &locked,
        true,
        Value::Undefined,
        same,
    )
    .unwrap();
    let replacement = DataDescriptor {
        value: Some(Value::Number(2.0)),
        writable: None,
        enumerable: None,
        configurable: None,
    };
    assert_eq!(
        class_object_define_data(
            &class,
            true,
            key.clone(),
            &replacement,
            true,
            Value::Undefined,
            same
        ),
        Err(DefineDataError::NonWritable)
    );
    assert!(matches!(
        class_object_lookup_data(&class, true, &key)
            .unwrap()
            .1
            .value,
        Value::Number(1.0)
    ));
    assert!(!class_object_delete_data(&class, true, &key));
}

#[test]
fn cycles_through_class_descriptors_are_traced_and_collected() {
    let class = class_object_new(1, None, vec![]);
    let weak = class.downgrade();
    define(
        &class,
        false,
        PropertyKey::String(string("self")),
        Value::Class(class.clone()),
    );
    collect_cycles();
    assert!(
        weak.upgrade().is_some(),
        "external class owner keeps the cycle live"
    );
    drop(class);
    collect_cycles();
    assert!(
        weak.upgrade().is_none(),
        "descriptor cycle must be reclaimed"
    );
}
