#[test]
fn indexed_numeric_reads_keep_values_and_convert_absence_to_nan() {
    let values = array_new(vec![0.0, -0.0, f64::NAN, f64::INFINITY, 4.0]);
    assert_eq!(array_get_number(&values, 4.0), 4.0);
    assert!(array_get_number(&values, 1.0).is_sign_negative());
    array_delete(&values, 3.0);
    array_set_undefined(&values, 4.0);
    for index in [2.0, 3.0, 4.0, 10.0, -1.0, 1.5, f64::NAN, f64::INFINITY] {
        assert!(array_get_number(&values, index).is_nan());
    }
    for (index, value) in [
        (-1.0, 7.0),
        (1.5, 9.0),
        (f64::NAN, 11.0),
        (f64::INFINITY, 13.0),
        (f64::from(u32::MAX), 15.0),
    ] {
        array_set(&values, index, value);
        assert_eq!(array_get_number(&values, index), value);
    }
    assert_eq!(array_len(&values), 5.0);
}

#[test]
fn indexed_equality_distinguishes_undefined_from_values_and_uses_strict_numeric_equality() {
    let values = array_new(vec![0.0, -0.0, f64::NAN, 4.0]);
    let absent = array_new::<f64>(Vec::new());
    array_set_undefined(&absent, 1.0);
    let equal = |left: &f64, right: &f64| left == right;
    assert!(array_index_equal_by(&values, 0.0, &values, 1.0, equal));
    assert!(!array_index_equal_by(&values, 2.0, &values, 2.0, equal));
    assert!(!array_index_equal_by(&absent, 0.0, &values, 0.0, equal));
    for left in [0.0, 1.0, 9.0, -1.0, f64::NAN] {
        for right in [0.0, 1.0, 9.0, -1.0, f64::NAN] {
            assert!(array_index_equal_by(&absent, left, &absent, right, equal));
        }
    }
    array_property_set(&values, string("NaN"), 11.0);
    array_property_set(&absent, string("NaN"), 11.0);
    assert!(array_index_equal_by(
        &values,
        f64::NAN,
        &absent,
        f64::NAN,
        equal
    ));
    assert!(!array_index_equal_by(
        &values,
        f64::NAN,
        &absent,
        0.0,
        equal
    ));
}

#[test]
fn indexed_equality_keeps_owned_string_snapshots_and_boolean_values() {
    let left = array_new(vec![string("é"), string("┌"), string("")]);
    let right = array_new(vec![string("e"), string("┌"), string("")]);
    assert!(!array_index_equal_by(&left, 0.0, &right, 0.0, |a, b| a == b));
    assert!(array_index_equal_by(&left, 1.0, &right, 1.0, |a, b| a == b));
    assert!(!array_index_equal_by(&left, 2.0, &right, 3.0, |a, b| a == b));
    assert!(array_index_equal_by(&left, 1.0, &right, 1.0, |a, b| {
        array_set(&right, 1.0, string("changed"));
        a == b
    }));
    let booleans = array_new(vec![false, true]);
    assert!(!array_index_equal_by(
        &booleans,
        0.0,
        &booleans,
        1.0,
        |a, b| a == b
    ));
    assert!(!array_index_equal_by(
        &booleans,
        0.0,
        &booleans,
        2.0,
        |a, b| a == b
    ));
}
