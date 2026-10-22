#[test]
fn repeat_preserves_units_and_finishes_empty_extreme_counts() {
    assert_eq!(string_repeat(&string(""), 9_007_199_254_740_992.0), "");
    assert_eq!(string_repeat(&string("a"), -0.9), "");
    assert_eq!(string_repeat(&string("a"), f64::NAN), "");
    assert_eq!(string_repeat(&string("é😀"), 2.9), "é😀é😀");
    let lone = JsString::from_utf16(&[0xd83d]);
    assert_eq!(
        string_repeat(&lone, 2.0).encode_utf16().collect::<Vec<_>>(),
        vec![0xd83d, 0xd83d]
    );
    let split = JsString::from_utf16(&[0xde00, 0xd83d]);
    assert_eq!(
        string_repeat(&split, 2.0)
            .encode_utf16()
            .collect::<Vec<_>>(),
        vec![0xde00, 0xd83d, 0xde00, 0xd83d]
    );
}

#[test]
fn repeat_throws_catchable_range_errors_before_allocation() {
    for (text, count, message) in [
        ("", -1.9, "Invalid count value: -1.9"),
        ("a", f64::INFINITY, "Invalid count value: Infinity"),
        ("", f64::NEG_INFINITY, "Invalid count value: -Infinity"),
        ("a", 536_870_889.0, "Invalid string length"),
        ("😀", 268_435_445.0, "Invalid string length"),
        ("a", 9_007_199_254_740_992.0, "Invalid string length"),
    ] {
        let payload = std::panic::catch_unwind(|| string_repeat(&string(text), count)).unwrap_err();
        let caught = caught_from_panic(payload);
        assert!(caught_is_error(&caught));
        let error = caught_error_value(&caught);
        assert_eq!(error_name(&error), "RangeError");
        assert_eq!(error_message(&error), message);
    }
}
