#[test]
fn far_array_values_preserve_length_slice_overwrites_and_truncation() {
    let values = array_new(vec![1.0]);
    array_set(&values, 4_000_000_000.0, 7.0);
    assert_eq!(array_len(&values), 4_000_000_001.0);
    assert_eq!(values.with(|data| data.elements.len()), 1);
    assert_eq!(array_get(&values, 4_000_000_000.0), 7.0);
    assert_eq!(array_next_present(&values, 2.0), 4_000_000_000.0);
    assert_eq!(
        array_index_of_by(&values, &7.0, |a, b| a == b),
        4_000_000_000.0
    );
    assert!(array_includes_by(&values, &7.0, |a, b| a == b));
    let copy = array_slice(&values, 4_000_000_000.0, 4_000_000_001.0);
    assert_eq!(array_len(&copy), 1.0);
    assert_eq!(array_get(&copy, 0.0), 7.0);
    array_set_undefined(&values, 4_000_000_000.0);
    assert_eq!(array_state(&values, 4_000_000_000.0), 2.0);
    array_set(&values, 4_000_000_000.0, 8.0);
    array_delete(&values, 4_000_000_000.0);
    assert!(!array_has(&values, 4_000_000_000.0));
    array_set_length(&values, 1.0);
    assert_eq!(array_values(&values), vec![1.0]);
    drop((values, copy));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn checked_undefined_search_distinguishes_empty_arrays_holes_and_values() {
    let values = array_new::<f64>(Vec::new());
    assert!(!array_includes_missing_by(&values, &0.0, true, |a, b| a == b));
    array_set(&values, 2.0, 4.0);
    assert!(array_includes_missing_by(&values, &0.0, true, |_, _| false));
    assert!(!array_includes_missing_by(&values, &0.0, false, |_, _| {
        false
    }));
    array_set_undefined(&values, 2.0);
    assert!(array_includes_missing_by(&values, &0.0, true, |_, _| false));
    drop(values);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[derive(Clone)]
enum SparseArrayCycle {
    Back(JsArray<SparseArrayCycle>),
}
impl ArrayElement for SparseArrayCycle {
    fn trace_element(&self, tracer: &mut Tracer<'_>) {
        let Self::Back(value) = self;
        tracer.edge(value);
    }
}

#[test]
fn sparse_tail_reference_cycles_are_traced_and_released() {
    let values = array_new(Vec::<SparseArrayCycle>::new());
    array_set(
        &values,
        4_000_000_000.0,
        SparseArrayCycle::Back(values.clone()),
    );
    drop(values);
    assert_eq!(collect_cycles(), 1);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn concat_keeps_holes_and_explicit_undefined_even_when_source_aliases_destination() {
    let values = array_new(vec![1.0]);
    array_set_length(&values, 3.0);
    array_set_undefined(&values, 2.0);
    assert_eq!(array_concat_from(&values, &values), 6.0);
    assert_eq!(array_get(&values, 3.0), 1.0);
    assert_eq!(array_state(&values, 4.0), 0.0);
    assert_eq!(array_state(&values, 5.0), 2.0);
    drop(values);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
