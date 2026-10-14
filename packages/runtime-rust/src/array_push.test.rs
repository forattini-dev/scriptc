#[test]
fn pushing_sparse_values_preserves_destination_states_and_observes_source_holes() {
    let destination = array_new(vec![1.0]);
    array_set_length(&destination, 3.0);
    let source = array_new(vec![4.0]);
    array_set_length(&source, 2.0);
    array_set_undefined(&source, 2.0);
    assert_eq!(array_push_from(&destination, &source), 6.0);
    assert_eq!(array_state(&destination, 1.0), 0.0);
    assert_eq!(array_get(&destination, 3.0), 4.0);
    assert_eq!(array_state(&destination, 4.0), 2.0);
    assert_eq!(array_state(&destination, 5.0), 2.0);
    assert_eq!(array_state(&source, 1.0), 0.0);
    assert_eq!(array_push_from(&source, &source), 6.0);
    assert_eq!(array_get(&source, 3.0), 4.0);
    assert_eq!(array_state(&source, 4.0), 2.0);
    assert_eq!(array_state(&source, 5.0), 2.0);
    drop((source, destination));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn pushing_sparse_reference_values_preserves_identity() {
    let value = array_new(vec![7.0]);
    let source = array_new(vec![value.clone()]);
    array_set_undefined(&source, 1.0);
    let destination = array_new(Vec::<JsArray<f64>>::new());
    array_push_from(&destination, &source);
    assert!(array_get(&destination, 0.0).ptr_eq(&value));
    array_set(&value, 0.0, 9.0);
    assert_eq!(array_get(&array_get(&destination, 0.0), 0.0), 9.0);
    assert_eq!(array_state(&destination, 1.0), 2.0);
    drop((source, destination, value));
    finish();
    assert_eq!(live_heap_objects(), 0);
}
