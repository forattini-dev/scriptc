#[test]
fn far_array_values_preserve_length_slice_overwrites_and_truncation() {
    let values = array_new(vec![1.0]);
    array_set(&values, 4_000_000_000.0, 7.0);
    assert_eq!(array_len(&values), 4_000_000_001.0);
    assert_eq!(values.with(|data| data.elements.len()), 1);
    assert_eq!(array_get(&values, 4_000_000_000.0), 7.0);
    assert_eq!(array_next_present(&values, 2.0), 4_000_000_000.0);
    assert_eq!(
        array_previous_present(&values, 4_000_000_000.0),
        4_000_000_000.0
    );
    assert_eq!(array_previous_present(&values, 3_999_999_999.0), 0.0);
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

#[test]
fn json_reviver_sparse_array_keys_preserve_absence_and_undefined() {
    let array = array_new(vec![1.0, 2.0, 3.0]);
    array_delete(&array, 1.0);
    array_set_undefined(&array, 4.0);
    array_set(&array, 4_000_000_000.0, 7.0);
    assert_eq!(
        array_own_index_keys(&array),
        vec![string("0"), string("2"), string("4"), string("4000000000")]
    );
    assert_eq!(array_len(&array), 4_000_000_001.0);
}
#[test]
fn fill_populates_holes_without_changing_identity_or_unselected_slots() {
    let array = array_new(vec![1.0, 2.0, 3.0]);
    array_delete(&array, 1.0);
    array_set_length(&array, 7.0);
    array_set_undefined(&array, 5.0);
    let returned = array_fill(&array, 9.0, -6.0, -2.0);
    assert!(array_ptr_eq(&array, &returned));
    assert_eq!(array_len(&array), 7.0);
    assert_eq!(
        array_values(&array_slice(&array, 0.0, 5.0)),
        vec![1.0, 9.0, 9.0, 9.0, 9.0]
    );
    assert_eq!(array_state(&array, 5.0), 2.0);
    assert_eq!(array_state(&array, 6.0), 0.0);
    array_fill(&array, 8.0, 5.0, f64::INFINITY);
    assert_eq!(
        array_values(&array),
        vec![1.0, 9.0, 9.0, 9.0, 9.0, 8.0, 8.0]
    );
    drop((array, returned));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn fill_far_sparse_tail_does_not_allocate_the_gap() {
    let array = array_new(vec![1.0]);
    array_set_length(&array, 4_000_000_002.0);
    array_set_undefined(&array, 4_000_000_000.0);
    array_fill(&array, 7.0, 4_000_000_000.0, f64::INFINITY);
    assert_eq!(array.with(|data| data.elements.len()), 1);
    assert_eq!(array_state(&array, 3_999_999_999.0), 0.0);
    assert_eq!(array_get(&array, 4_000_000_000.0), 7.0);
    assert_eq!(array_get(&array, 4_000_000_001.0), 7.0);
    drop(array);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn shift_optional_preserves_holes_undefined_and_large_sparse_indices() {
    let values = array_new(vec![1.0, 2.0, 3.0, 4.0]);
    array_delete(&values, 0.0);
    array_set_undefined(&values, 1.0);
    array_delete(&values, 3.0);
    assert_eq!(array_shift_optional(&values), None);
    assert_eq!(array_len(&values), 3.0);
    assert_eq!((array_state(&values, 0.0), array_state(&values, 1.0), array_state(&values, 2.0)), (2.0, 1.0, 0.0));
    assert_eq!(array_get(&values, 1.0), 3.0);
    assert_eq!(array_shift_optional(&values), None);
    assert_eq!(array_shift_optional(&values), Some(3.0));
    assert_eq!(array_shift_optional(&values), None);
    assert_eq!(array_shift_optional(&values), None);

    let sparse = array_new::<f64>(Vec::new());
    array_set_undefined(&sparse, 3_999_999_999.0);
    array_set(&sparse, 4_000_000_000.0, 9.0);
    assert_eq!(array_shift_optional(&sparse), None);
    assert_eq!(array_len(&sparse), 4_000_000_000.0);
    assert_eq!(array_state(&sparse, 3_999_999_998.0), 2.0);
    assert_eq!(array_get(&sparse, 3_999_999_999.0), 9.0);
}
