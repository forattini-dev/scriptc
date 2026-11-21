use super::*;
use crate::{string, symbol_new};

fn key(name: &str) -> PropertyKey {
    PropertyKey::String(string(name))
}
fn same(a: &u32, b: &u32) -> bool {
    a == b
}

#[test]
fn accessor_definition_preserves_omission_undefined_and_identity() {
    let mut table = OrdinaryPropertyTable::new();
    let property = key("color");
    table
        .define(
            property.clone(),
            &OrdinaryDescriptor {
                get: Some(7),
                enumerable: Some(true),
                ..Default::default()
            },
            true,
            0,
            same,
        )
        .unwrap();
    assert_eq!(
        table.get(&property),
        Some(&OrdinaryProperty::Accessor(AccessorProperty {
            get: 7,
            set: 0,
            enumerable: true,
            configurable: false,
        }))
    );
    assert_eq!(table.write_own(&property, 8), OrdinaryWrite::Setter(0));
    assert_eq!(
        table.define(
            property.clone(),
            &OrdinaryDescriptor {
                get: Some(7),
                ..Default::default()
            },
            false,
            0,
            same
        ),
        Ok(())
    );
    assert_eq!(
        table.define(
            property.clone(),
            &OrdinaryDescriptor {
                get: Some(0),
                ..Default::default()
            },
            false,
            0,
            same
        ),
        Err(DefineOrdinaryError::NonConfigurable)
    );
    assert!(!table.delete(&property));
    assert_eq!(table.trace_snapshot(), vec![7, 0]);
}

impl OrdinaryPropertyTable<u32> {
    fn trace_snapshot(&self) -> Vec<u32> {
        let mut values = Vec::new();
        self.trace_values(|value| values.push(*value));
        values
    }
}

#[test]
fn conversion_between_data_and_accessors_is_atomic_and_keeps_attributes() {
    let mut table = OrdinaryPropertyTable::new();
    let property = key("field");
    table
        .define(
            property.clone(),
            &OrdinaryDescriptor {
                value: Some(4),
                writable: Some(true),
                enumerable: Some(true),
                configurable: Some(true),
                ..Default::default()
            },
            true,
            0,
            same,
        )
        .unwrap();
    assert_eq!(
        table.define(
            property.clone(),
            &OrdinaryDescriptor {
                value: Some(8),
                get: Some(9),
                ..Default::default()
            },
            true,
            0,
            same
        ),
        Err(DefineOrdinaryError::InvalidDescriptor)
    );
    assert_eq!(
        table.get(&property),
        Some(&OrdinaryProperty::Data(DataProperty {
            value: 4,
            writable: true,
            enumerable: true,
            configurable: true,
        }))
    );
    table
        .define(
            property.clone(),
            &OrdinaryDescriptor {
                get: Some(9),
                ..Default::default()
            },
            false,
            0,
            same,
        )
        .unwrap();
    assert_eq!(
        table.get(&property),
        Some(&OrdinaryProperty::Accessor(AccessorProperty {
            get: 9,
            set: 0,
            enumerable: true,
            configurable: true,
        }))
    );
    table
        .define(
            property.clone(),
            &OrdinaryDescriptor {
                value: Some(6),
                configurable: Some(false),
                ..Default::default()
            },
            false,
            0,
            same,
        )
        .unwrap();
    assert_eq!(table.write_own(&property, 2), OrdinaryWrite::NonWritable);
    assert_eq!(
        table.define(
            property.clone(),
            &OrdinaryDescriptor {
                value: Some(7),
                ..Default::default()
            },
            true,
            0,
            same
        ),
        Err(DefineOrdinaryError::NonWritable)
    );
    assert!(!table.delete(&property));
}

#[test]
fn own_keys_keep_javascript_order_across_data_and_accessor_descriptors() {
    let mut table = OrdinaryPropertyTable::new();
    let symbol = PropertyKey::Symbol(symbol_new(&string("s")));
    for (property, descriptor) in [
        (
            key("name"),
            OrdinaryDescriptor {
                get: Some(1),
                enumerable: Some(true),
                ..Default::default()
            },
        ),
        (
            symbol.clone(),
            OrdinaryDescriptor {
                value: Some(2),
                enumerable: Some(true),
                ..Default::default()
            },
        ),
        (
            key("10"),
            OrdinaryDescriptor {
                get: Some(3),
                enumerable: Some(true),
                ..Default::default()
            },
        ),
        (
            key("2"),
            OrdinaryDescriptor {
                value: Some(4),
                enumerable: Some(true),
                ..Default::default()
            },
        ),
        (
            key("hidden"),
            OrdinaryDescriptor {
                get: Some(5),
                ..Default::default()
            },
        ),
    ] {
        table.define(property, &descriptor, true, 0, same).unwrap();
    }
    assert!(table.own_keys(true) == vec![key("2"), key("10"), key("name"), symbol.clone()]);
    assert!(table.own_keys(false) == vec![key("2"), key("10"), key("name"), key("hidden"), symbol]);
    assert_eq!(
        table.define(key("new"), &OrdinaryDescriptor::default(), false, 0, same),
        Err(DefineOrdinaryError::NotExtensible)
    );
}

#[test]
fn accessor_edges_participate_in_cycle_collection() {
    use crate::{ClearEdges, Gc, Trace, Tracer, collect_cycles, finish, live_heap_objects};
    struct Owner {
        properties: OrdinaryPropertyTable<Option<Gc<Owner>>>,
    }
    impl Trace for Owner {
        fn trace(&self, tracer: &mut Tracer<'_>) {
            self.properties.trace_values(|value| {
                if let Some(edge) = value {
                    tracer.edge(edge);
                }
            });
        }
    }
    impl ClearEdges for Owner {
        fn clear_edges(&mut self) {
            self.properties = OrdinaryPropertyTable::new();
        }
    }
    let object = Gc::new(Owner {
        properties: OrdinaryPropertyTable::new(),
    });
    object.with_mut(|owner| {
        owner
            .properties
            .define(
                key("getter"),
                &OrdinaryDescriptor {
                    get: Some(Some(object.clone())),
                    ..Default::default()
                },
                true,
                None,
                |a, b| match (a, b) {
                    (Some(a), Some(b)) => a.ptr_eq(b),
                    (None, None) => true,
                    _ => false,
                },
            )
            .unwrap();
    });
    drop(object);
    assert_eq!(collect_cycles(), 1);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn symbol_accessors_with_the_same_description_keep_distinct_keys() {
    let first = PropertyKey::Symbol(symbol_new(&string("key")));
    let second = PropertyKey::Symbol(symbol_new(&string("key")));
    let mut table = OrdinaryPropertyTable::new();
    table
        .define(
            first.clone(),
            &OrdinaryDescriptor {
                get: Some(1),
                configurable: Some(true),
                ..Default::default()
            },
            true,
            0,
            same,
        )
        .unwrap();
    table
        .define(
            second.clone(),
            &OrdinaryDescriptor {
                get: Some(2),
                configurable: Some(true),
                ..Default::default()
            },
            true,
            0,
            same,
        )
        .unwrap();
    assert!(table.own_keys(false) == vec![first.clone(), second.clone()]);
    assert!(table.delete(&first));
    assert_eq!(
        table.get(&second),
        Some(&OrdinaryProperty::Accessor(AccessorProperty {
            get: 2,
            set: 0,
            enumerable: false,
            configurable: true,
        }))
    );
}
