use super::*;
use crate::{string, symbol_for, symbol_new};

fn same(a: &f64, b: &f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

#[test]
fn new_data_descriptors_default_to_false_and_undefined() {
    let actual =
        define_data_property(None, &DataDescriptor::default(), true, f64::NAN, same).unwrap();
    assert!(actual.value.is_nan());
    assert!(!actual.writable && !actual.enumerable && !actual.configurable);
    assert_eq!(
        define_data_property::<f64>(None, &DataDescriptor::default(), false, f64::NAN, same),
        Err(DefineDataError::NotExtensible)
    );
}

#[test]
fn nonconfigurable_properties_enforce_attributes_and_same_value() {
    let current = DataProperty {
        value: -0.0,
        writable: false,
        enumerable: true,
        configurable: false,
    };
    for descriptor in [
        DataDescriptor {
            configurable: Some(true),
            ..Default::default()
        },
        DataDescriptor {
            enumerable: Some(false),
            ..Default::default()
        },
    ] {
        assert_eq!(
            define_data_property(Some(&current), &descriptor, true, f64::NAN, same),
            Err(DefineDataError::NonConfigurable)
        );
    }
    for descriptor in [
        DataDescriptor {
            value: Some(0.0),
            ..Default::default()
        },
        DataDescriptor {
            writable: Some(true),
            ..Default::default()
        },
    ] {
        assert_eq!(
            define_data_property(Some(&current), &descriptor, true, f64::NAN, same),
            Err(DefineDataError::NonWritable)
        );
    }
    let unchanged = DataDescriptor {
        value: Some(-0.0),
        ..Default::default()
    };
    assert_eq!(
        define_data_property(Some(&current), &unchanged, false, f64::NAN, same)
            .unwrap()
            .value
            .to_bits(),
        (-0.0_f64).to_bits()
    );
    let nan = DataProperty {
        value: f64::NAN,
        ..current
    };
    assert!(
        define_data_property(
            Some(&nan),
            &DataDescriptor {
                value: Some(f64::NAN),
                ..Default::default()
            },
            false,
            f64::NAN,
            same
        )
        .is_ok()
    );
}

#[test]
fn writable_nonconfigurable_property_can_be_frozen_but_not_reopened() {
    let current = DataProperty {
        value: 1.0,
        writable: true,
        enumerable: true,
        configurable: false,
    };
    let frozen = define_data_property(
        Some(&current),
        &DataDescriptor {
            value: Some(2.0),
            writable: Some(false),
            ..Default::default()
        },
        false,
        f64::NAN,
        same,
    )
    .unwrap();
    assert_eq!(frozen.value, 2.0);
    assert!(!frozen.writable);
    assert_eq!(
        define_data_property(
            Some(&frozen),
            &DataDescriptor {
                writable: Some(true),
                ..Default::default()
            },
            false,
            f64::NAN,
            same
        ),
        Err(DefineDataError::NonWritable)
    );
}

#[test]
fn property_keys_keep_symbol_identity_separate_from_description_and_strings() {
    let first = symbol_new(&string("resource"));
    let second = symbol_new(&string("resource"));
    assert!(PropertyKey::Symbol(first.clone()) == PropertyKey::Symbol(first));
    assert!(PropertyKey::Symbol(second) != PropertyKey::String(string("resource")));
    assert!(
        PropertyKey::Symbol(symbol_new(&string("resource")))
            != PropertyKey::Symbol(symbol_new(&string("resource")))
    );
    assert!(
        PropertyKey::Symbol(symbol_for(&string("resource")))
            == PropertyKey::Symbol(symbol_for(&string("resource")))
    );
}

#[test]
fn property_table_preserves_identity_order_and_failed_updates() {
    let name = PropertyKey::String(string("resource"));
    let symbol = PropertyKey::Symbol(symbol_new(&string("resource")));
    let other = PropertyKey::Symbol(symbol_new(&string("resource")));
    let mut table = DataPropertyTable::new();
    let fixed = DataDescriptor {
        value: Some(1.0),
        ..Default::default()
    };
    table
        .define(name.clone(), &fixed, true, f64::NAN, same)
        .unwrap();
    let mutable = DataDescriptor {
        value: Some(2.0),
        writable: Some(true),
        enumerable: Some(true),
        configurable: Some(true),
    };
    table
        .define(symbol.clone(), &mutable, true, f64::NAN, same)
        .unwrap();
    table
        .define(other.clone(), &mutable, true, f64::NAN, same)
        .unwrap();
    assert_eq!(table.iter().count(), 3);
    assert_eq!(
        table.define(name.clone(), &mutable, true, f64::NAN, same),
        Err(DefineDataError::NonConfigurable)
    );
    assert_eq!(table.get(&name).unwrap().value, 1.0);
    assert_eq!(table.write_own(&name, 3.0), WriteOwnDataResult::NonWritable);
    assert_eq!(table.write_own(&symbol, 3.0), WriteOwnDataResult::Written);
    assert_eq!(table.get(&symbol).unwrap().value, 3.0);
    assert_eq!(
        table.write_own(&PropertyKey::String(string("missing")), 4.0),
        WriteOwnDataResult::Missing
    );
    assert!(!table.delete(&name));
    assert!(table.delete(&symbol));
    assert!(table.get(&symbol).is_none());
    assert_eq!(table.get(&other).unwrap().value, 2.0);
    table
        .define(symbol.clone(), &mutable, true, f64::NAN, same)
        .unwrap();
    let keys = table.iter().map(|(key, _)| key).collect::<Vec<_>>();
    assert!(keys[0] == &name && keys[1] == &other && keys[2] == &symbol);
    let mut visited = Vec::new();
    table.trace_values(|value| visited.push(*value));
    assert_eq!(visited, vec![1.0, 2.0, 2.0]);
}

#[test]
fn own_keys_order_indices_then_strings_then_symbol_identity() {
    let mut table = DataPropertyTable::<f64>::new();
    let first = PropertyKey::Symbol(symbol_new(&string("same")));
    let second = PropertyKey::Symbol(symbol_new(&string("same")));
    let text = |value: &str| PropertyKey::String(string(value));
    let descriptor = DataDescriptor {
        value: Some(1.0),
        writable: Some(true),
        enumerable: Some(true),
        configurable: Some(true),
    };
    let hidden = DataDescriptor {
        enumerable: Some(false),
        ..descriptor.clone()
    };
    for key in [
        first.clone(),
        text("10"),
        text("z"),
        text("2"),
        text("01"),
        text("4294967295"),
        second.clone(),
        text("0"),
        text("4294967294"),
    ] {
        table
            .define(key, &descriptor, true, f64::NAN, same)
            .unwrap();
    }
    table
        .define(text("2"), &hidden, true, f64::NAN, same)
        .unwrap();
    table
        .define(
            first.clone(),
            &DataDescriptor {
                writable: Some(false),
                ..Default::default()
            },
            true,
            f64::NAN,
            same,
        )
        .unwrap();
    let all = table.own_keys(false);
    let expected = [
        text("0"),
        text("2"),
        text("10"),
        text("4294967294"),
        text("z"),
        text("01"),
        text("4294967295"),
        first.clone(),
        second.clone(),
    ];
    assert!(all == expected);
    let enumerable = table.own_keys(true);
    let expected = [
        text("0"),
        text("10"),
        text("4294967294"),
        text("z"),
        text("01"),
        text("4294967295"),
        first,
        second,
    ];
    assert!(enumerable == expected);
    let copy = table.copy_enumerable_to_new();
    assert!(copy.own_keys(false) == expected);
    assert!(copy.get(&text("2")).is_none());
    for key in copy.own_keys(false) {
        let property = copy.get(&key).unwrap();
        assert!(property.writable && property.enumerable && property.configurable);
    }
}

#[test]
fn legacy_symbol_entry_snapshot_retains_identity_order_and_values() {
    let map = crate::map_new::<JsString, f64>();
    let first = symbol_new(&string("same"));
    let second = symbol_new(&string("same"));
    crate::map_symbol_set(&map, first.clone(), 1.0);
    crate::map_symbol_set(&map, second.clone(), 2.0);
    let snapshot = crate::map_symbol_entries(&map);
    crate::map_symbol_set(&map, first.clone(), 3.0);
    assert_eq!(snapshot.len(), 2);
    assert!(symbol_ptr_eq(&snapshot[0].0, &first));
    assert!(symbol_ptr_eq(&snapshot[1].0, &second));
    assert_eq!((snapshot[0].1, snapshot[1].1), (1.0, 2.0));
}
