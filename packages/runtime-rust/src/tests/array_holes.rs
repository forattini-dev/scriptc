#[test]
fn sparse_array_states_follow_length_growth_writes_and_deletes() {
    let array = array_new(vec![1.0, 2.0]);
    array_set_length(&array, 5.0);
    assert_eq!(array_len(&array), 5.0);
    assert_eq!(array_state(&array, 1.0), 1.0);
    assert_eq!(array_state(&array, 3.0), 0.0);

    array_set(&array, 4.0, 9.0);
    assert_eq!(array_state(&array, 2.0), 0.0);
    assert_eq!(array_state(&array, 4.0), 1.0);
    assert_eq!(array_get(&array, 4.0), 9.0);

    array_set_undefined(&array, 3.0);
    assert_eq!(array_state(&array, 3.0), 2.0);
    assert!(array_has(&array, 3.0));
    assert!(!array_has(&array, 2.0));
    assert_eq!(array_next_present(&array, 2.0), 3.0);

    array_delete(&array, 0.0);
    assert_eq!(array_state(&array, 0.0), 0.0);
    assert_eq!(array_len(&array), 5.0);

    array_set(&array, 0.0, 7.0);
    array_set(&array, 2.0, 8.0);
    array_set(&array, 3.0, 6.0);
    assert_eq!(array_values(&array), vec![7.0, 2.0, 8.0, 6.0, 9.0]);
}

#[test]
fn sparse_array_tail_undefined_and_truncation() {
    let array: JsArray<f64> = array_new(Vec::new());
    array_set_undefined(&array, 2.0);
    assert_eq!(array_len(&array), 3.0);
    assert_eq!(array_state(&array, 0.0), 0.0);
    assert_eq!(array_state(&array, 2.0), 2.0);
    assert_eq!(array_next_present(&array, 0.0), 2.0);

    array_set_length(&array, 2.0);
    assert_eq!(array_len(&array), 2.0);
    assert_eq!(array_next_present(&array, 0.0), 2.0);
    assert_eq!(array_push(&array, 4.0), 3.0);
    assert_eq!(array_state(&array, 2.0), 1.0);
    assert_eq!(array_pop(&array), 4.0);
    assert_eq!(array_len(&array), 2.0);
}

#[test]
fn reading_a_hole_as_a_value_fails_explicitly() {
    let array = array_new(vec![1.0]);
    array_set_length(&array, 3.0);
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| array_get(&array, 2.0)))
        .err()
        .expect("a hole read must fail");
    let caught = caught_from_panic(payload);
    assert!(caught_is_error(&caught));
}
