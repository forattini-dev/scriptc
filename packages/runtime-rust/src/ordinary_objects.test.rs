use super::*;
use crate::{HeapValue, string};

#[derive(Clone, Debug, PartialEq, Default)]
enum Value {
    #[default]
    Undefined,
    Number(i32),
    Getter,
    Setter,
}
impl HeapValue for Value {}
fn key(name: &str) -> PropertyKey {
    PropertyKey::String(string(name))
}
fn is_undefined(value: &Value) -> bool {
    *value == Value::Undefined
}

#[test]
fn getter_and_setter_receive_original_object_and_may_reenter() {
    let object = ordinary_object_new::<Value>();
    let alias = object.clone();
    let property = key("value");
    ordinary_object_define(
        &object,
        property.clone(),
        &OrdinaryDescriptor {
            get: Some(Value::Getter),
            set: Some(Value::Setter),
            enumerable: Some(true),
            configurable: Some(true),
            ..Default::default()
        },
        Value::Undefined,
        |a, b| a == b,
    )
    .unwrap();
    let read = ordinary_object_get(
        &object,
        &property,
        Value::Undefined,
        is_undefined,
        |getter, receiver| {
            assert_eq!(getter, Value::Getter);
            assert!(receiver.ptr_eq(&alias));
            assert!(ordinary_object_set(
                &receiver,
                key("during_get"),
                Value::Number(1),
                Value::Undefined,
                is_undefined,
                |_, _, _| panic!("not a setter")
            ));
            Value::Number(42)
        },
    );
    assert_eq!(read, Value::Number(42));
    assert!(ordinary_object_set(
        &object,
        property,
        Value::Number(9),
        Value::Undefined,
        is_undefined,
        |setter, receiver, value| {
            assert_eq!(setter, Value::Setter);
            assert!(receiver.ptr_eq(&alias));
            assert!(ordinary_object_set(
                &receiver,
                key("during_set"),
                value,
                Value::Undefined,
                is_undefined,
                |_, _, _| panic!("not a setter")
            ));
        }
    ));
    assert_eq!(
        ordinary_object_get(
            &object,
            &key("during_set"),
            Value::Undefined,
            is_undefined,
            |_, _| panic!("not a getter")
        ),
        Value::Number(9)
    );
    drop((object, alias));
    crate::finish();
    assert_eq!(crate::live_heap_objects(), 0);
}

#[test]
fn undefined_accessors_and_extensibility_obey_own_property_rules() {
    let object = ordinary_object_new::<Value>();
    let name = key("read_only");
    ordinary_object_define(
        &object,
        name.clone(),
        &OrdinaryDescriptor {
            get: Some(Value::Undefined),
            ..Default::default()
        },
        Value::Undefined,
        |a, b| a == b,
    )
    .unwrap();
    assert_eq!(
        ordinary_object_get(
            &object,
            &name,
            Value::Undefined,
            is_undefined,
            |_, _| panic!("undefined getter called")
        ),
        Value::Undefined
    );
    assert!(!ordinary_object_set(
        &object,
        name.clone(),
        Value::Number(2),
        Value::Undefined,
        is_undefined,
        |_, _, _| panic!("undefined setter called")
    ));
    assert!(!ordinary_object_delete(&object, &name));
    ordinary_object_prevent_extensions(&object);
    assert!(!ordinary_object_set(
        &object,
        key("new"),
        Value::Number(3),
        Value::Undefined,
        is_undefined,
        |_, _, _| panic!("unexpected setter")
    ));
    assert_eq!(
        ordinary_object_define(
            &object,
            key("new"),
            &OrdinaryDescriptor::default(),
            Value::Undefined,
            |a, b| a == b
        ),
        Err(DefineOrdinaryError::NotExtensible)
    );
    drop(object);
    crate::finish();
    assert_eq!(crate::live_heap_objects(), 0);
}

#[test]
fn object_getter_cycle_is_collectable() {
    use crate::{ClearEdges, Gc, JsOrdinaryObject, Trace, Tracer, collect_cycles};
    #[derive(Clone)]
    enum CycleValue {
        Undefined,
        Function(Gc<Function>),
    }
    struct Function {
        owner: Option<JsOrdinaryObject<CycleValue>>,
    }
    impl Trace for Function {
        fn trace(&self, tracer: &mut Tracer<'_>) {
            if let Some(owner) = &self.owner {
                tracer.edge(owner);
            }
        }
    }
    impl ClearEdges for Function {
        fn clear_edges(&mut self) {
            self.owner = None;
        }
    }
    impl HeapValue for CycleValue {
        fn trace_value(&self, tracer: &mut Tracer<'_>) {
            if let Self::Function(function) = self {
                tracer.edge(function);
            }
        }
    }
    let object = ordinary_object_new::<CycleValue>();
    let function = Gc::new(Function {
        owner: Some(object.clone()),
    });
    ordinary_object_define(
        &object,
        key("cycle"),
        &OrdinaryDescriptor {
            get: Some(CycleValue::Function(function.clone())),
            ..Default::default()
        },
        CycleValue::Undefined,
        |left, right| match (left, right) {
            (CycleValue::Undefined, CycleValue::Undefined) => true,
            (CycleValue::Function(left), CycleValue::Function(right)) => left.ptr_eq(right),
            _ => false,
        },
    )
    .unwrap();
    drop(function);
    drop(object);
    assert_eq!(collect_cycles(), 2);
    crate::finish();
    assert_eq!(crate::live_heap_objects(), 0);
}
