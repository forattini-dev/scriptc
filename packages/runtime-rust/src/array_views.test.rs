thread_local! { static ARRAY_VIEW_READS: Cell<usize> = const { Cell::new(0) }; }
fn mapped_number(value: f64) -> JsString {
    ARRAY_VIEW_READS.with(|count| count.set(count.get() + 1));
    string(&format_number(value))
}
fn mapped_string(value: JsString) -> f64 { value.parse().unwrap() }

#[test]
fn array_iterator_or_observes_live_holes_undefined_and_completion() {
    let source = array_new(vec![1.0, 2.0, 3.0]);
    let iterator = array_iterator_new(&source, ArrayIteratorKind::Values);
    assert!(matches!(array_iterator_next_or(&iterator, -1.0), Some(ArrayIteratorItem::Value(1.0))));
    array_delete(&source, 1.0);
    array_set_undefined(&source, 2.0);
    array_push(&source, 4.0);
    assert!(matches!(array_iterator_next_or(&iterator, -1.0), Some(ArrayIteratorItem::Value(-1.0))));
    assert!(matches!(array_iterator_next_or(&iterator, -1.0), Some(ArrayIteratorItem::Value(-1.0))));
    assert!(matches!(array_iterator_next_or(&iterator, -1.0), Some(ArrayIteratorItem::Value(4.0))));
    assert!(array_iterator_next_or(&iterator, -1.0).is_none());
    array_push(&source, 5.0);
    assert!(array_iterator_next_or(&iterator, -1.0).is_none());
    let entries = array_iterator_new(&source, ArrayIteratorKind::Entries);
    assert!(matches!(array_iterator_next_or(&entries, -1.0), Some(ArrayIteratorItem::Entry(0.0, 1.0))));
    assert!(matches!(array_iterator_next_or(&entries, -1.0), Some(ArrayIteratorItem::Entry(1.0, -1.0))));
    let keys = array_iterator_new(&source, ArrayIteratorKind::Keys);
    assert!(matches!(array_iterator_next_or(&keys, -1.0), Some(ArrayIteratorItem::Key(0.0))));
    assert!(matches!(array_iterator_next_or(&keys, -1.0), Some(ArrayIteratorItem::Key(1.0))));
    let generator: JsGenerator<f64, (), ()> = generator_from_array_or(source, -1.0);
    assert!(matches!(generator_next(&generator, ()), GeneratorStep::Yielded(1.0)));
    assert!(matches!(generator_next(&generator, ()), GeneratorStep::Yielded(-1.0)));
    assert!(matches!(generator_next(&generator, ()), GeneratorStep::Yielded(-1.0)));
}

#[test]
fn mapped_arrays_share_named_properties_with_their_source() {
    let source = array_new(vec![1.0]);
    let view = array_mapped(source.clone(), mapped_number, mapped_string);
    let nested = array_mapped(view.clone(), |value| value, |value| value);
    array_property_set(&source, string("first"), 7.0);
    assert_eq!(array_property_get(&view, &string("first")), Some(string("7")));
    array_property_set(&nested, string("second"), string("12"));
    assert_eq!(array_property_get(&source, &string("second")), Some(12.0));
    assert!(array_property_has(&view, &string("second")));
    assert_eq!(array_property_keys(&nested), vec![string("first"), string("second")]);
}

#[test]
fn mapped_arrays_share_identity_and_scalar_storage_without_eager_conversion() {
    ARRAY_VIEW_READS.with(|count| count.set(0));
    let source = array_new_with_raw(vec![1.0, 2.0], vec![10.0, 20.0]);
    let view = array_mapped(source.clone(), mapped_number, mapped_string);
    let other = array_mapped(source.clone(), mapped_number, mapped_string);
    assert!(array_ptr_eq(&view, &other));
    assert!(array_ptr_eq(&source, &array_mapped_source::<f64, _>(&view).unwrap()));
    assert_eq!(array_len(&view), 2.0);
    array_push(&view, string("3"));
    array_set(&view, 0.0, string("9"));
    assert_eq!(array_values(&source), vec![9.0, 2.0, 3.0]);
    ARRAY_VIEW_READS.with(|count| assert_eq!(count.get(), 0));
    array_set(&source, 1.0, 8.0);
    assert_eq!(array_get(&view, 1.0).as_ref(), "8");
    ARRAY_VIEW_READS.with(|count| assert_eq!(count.get(), 1));
    assert_eq!(array_pop(&view).as_ref(), "3");
    assert_eq!(array_len(&source), 2.0);
    let raw = array_raw(&view).unwrap();
    assert_eq!(array_get(&raw, 0.0).as_ref(), "10");
    array_set(&raw, 0.0, string("11"));
    assert_eq!(array_get(&array_raw(&source).unwrap(), 0.0), 11.0);
    drop((source, view, other, raw));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn mapped_arrays_support_bulk_mutation_readers_and_iterators() {
    let source = array_new(vec![1.0, 2.0, 3.0]);
    let view = array_mapped(source.clone(), mapped_number, mapped_string);
    array_reverse(&view);
    array_fill(&view, string("8"), 1.0, 2.0);
    array_copy_within(&view, 2.0, 0.0, 1.0);
    assert_eq!(array_values(&source), vec![3.0, 8.0, 3.0]);
    let removed = array_splice_with_items(&view, 1.0, 1.0, vec![string("4"), string("5")]);
    assert_eq!(array_get(&removed, 0.0).as_ref(), "8");
    array_sort_by_snapshot(&view, |a, b| a.cmp(b));
    assert_eq!(array_values(&source), vec![3.0, 3.0, 4.0, 5.0]);
    assert_eq!(array_join(&view, &string(",")).as_ref(), "3,3,4,5");
    assert_eq!(json_stringify(&view).as_ref(), "[\"3\",\"3\",\"4\",\"5\"]");
    let slice = array_slice(&view, 1.0, 3.0);
    assert_eq!(array_join(&slice, &string(",")).as_ref(), "3,4");
    let iterator = array_iterator_new(&view, ArrayIteratorKind::Values);
    assert!(matches!(array_iterator_next(&iterator), Some(ArrayIteratorItem::Value(value)) if value.as_ref() == "3"));
    array_set(&source, 1.0, 7.0);
    assert!(matches!(array_iterator_next(&iterator), Some(ArrayIteratorItem::Value(value)) if value.as_ref() == "7"));
    array_unshift(&view, vec![string("0")]);
    assert_eq!(array_shift(&view).as_ref(), "0");
    array_extend(&view, &slice);
    assert_eq!(array_values(&source), vec![3.0, 7.0, 4.0, 5.0, 3.0, 4.0]);
    drop((source, view, removed, slice, iterator));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SliceViewValue { Text(JsString), Absent }
impl ArrayElement for SliceViewValue {}

#[test]
fn slicing_a_mapped_array_preserves_unrepresentable_values_and_holes() {
    fn read(value: SliceViewValue) -> JsString {
        match value {
            SliceViewValue::Text(value) => value,
            SliceViewValue::Absent => panic!("slice must not eagerly narrow a value"),
        }
    }
    fn write(value: JsString) -> SliceViewValue { SliceViewValue::Text(value) }
    let source = array_new(vec![SliceViewValue::Text(string("a")), SliceViewValue::Absent, SliceViewValue::Text(string("b"))]);
    array_delete(&source, 0.0);
    array_set_undefined(&source, 2.0);
    let view = array_mapped(source.clone(), read, write);
    let copy = array_slice(&view, 0.0, 3.0);
    let raw = array_mapped_source::<SliceViewValue, JsString>(&copy).unwrap();
    assert_eq!(array_state(&raw, 0.0), 0.0);
    assert_eq!(array_state(&raw, 1.0), 1.0);
    assert_eq!(array_get(&raw, 1.0), SliceViewValue::Absent);
    assert_eq!(array_state(&raw, 2.0), 2.0);
    array_set(&source, 1.0, SliceViewValue::Text(string("changed")));
    assert_eq!(array_get(&raw, 1.0), SliceViewValue::Absent);
}

#[derive(Clone)]
enum MappedArrayCycle { Back(JsArray<MappedArrayCycle>) }
impl ArrayElement for MappedArrayCycle {
    fn trace_element(&self, tracer: &mut Tracer<'_>) {
        let Self::Back(value) = self;
        tracer.edge(value);
    }
}

#[test]
fn mapped_array_backing_edges_are_collectible() {
    let source = array_new(Vec::<MappedArrayCycle>::new());
    let view = array_mapped(source.clone(), |value| value, |value| value);
    array_push(&source, MappedArrayCycle::Back(view.clone()));
    drop((source, view));
    assert_eq!(collect_cycles(), 2);
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn mapped_arrays_retain_live_holes_undefined_and_sparse_keys_without_decoding() {
    ARRAY_VIEW_READS.with(|count| count.set(0));
    let source = array_new(vec![1.0, 2.0, 3.0]);
    let view = array_mapped(source.clone(), mapped_number, mapped_string);
    let nested = array_mapped(view.clone(), |value| value, |value| value);
    array_delete(&source, 1.0);
    array_set_undefined(&source, 2.0);
    array_set_length(&source, 5.0);
    for array in [&view, &nested] {
        assert_eq!(array_len(array), 5.0);
        assert_eq!((array_state(array, 0.0), array_state(array, 1.0), array_state(array, 2.0), array_state(array, 4.0)), (1.0, 0.0, 2.0, 0.0));
        assert!(!array_has(array, 1.0));
        assert!(array_has(array, 2.0));
        assert_eq!(array_next_present(array, 1.0), 2.0);
        assert_eq!(array_next_present(array, 3.0), 5.0);
        assert_eq!(array_own_index_keys(array), vec![string("0"), string("2")]);
    }
    ARRAY_VIEW_READS.with(|count| assert_eq!(count.get(), 0));
    array_set(&source, 1.0, 9.0);
    assert_eq!(array_state(&nested, 1.0), 1.0);
    assert_eq!(array_get(&nested, 1.0), string("9"));
    array_set_length(&source, 1.0);
    assert_eq!(array_next_present(&nested, 1.0), 1.0);
    assert_eq!(array_own_index_keys(&nested), vec![string("0")]);
    drop((source, view, nested));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn sorting_sparse_mapped_arrays_preserves_slots_and_identity() {
    let source = array_new(vec![10.0, 2.0, 8.0, 1.0]);
    let view = array_mapped(source.clone(), mapped_number, mapped_string);
    array_delete(&source, 1.0);
    array_set_undefined(&source, 2.0);
    array_set_length(&source, 8.0);
    let mut comparisons = 0;
    let sorted = array_sort_by_snapshot(&view, |left, right| {
        comparisons += 1;
        left.cmp(right)
    });
    assert!(array_ptr_eq(&view, &sorted));
    assert_eq!(comparisons, 1);
    assert_eq!(array_len(&source), 8.0);
    assert_eq!(array_get(&source, 0.0), 1.0);
    assert_eq!(array_get(&source, 1.0), 10.0);
    assert_eq!(array_state(&source, 2.0), 2.0);
    assert_eq!(array_state(&source, 3.0), 0.0);
    assert_eq!(array_next_present(&source, 3.0), 8.0);
    assert_eq!(array_join(&view, &string("|")).as_ref(), "1|10||||||");
    drop((source, view, sorted));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn sort_snapshots_values_before_comparator_mutations() {
    let array = array_new(vec![3.0, 1.0, 2.0]);
    let alias = array.clone();
    array_sort_by_snapshot(&array, |left, right| {
        array_set_length(&alias, 1.0);
        left.partial_cmp(right).unwrap()
    });
    assert_eq!(array_values(&array), vec![1.0, 2.0, 3.0]);
    drop((array, alias));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn sort_does_not_reextend_trailing_holes_after_comparator_shrinks_length() {
    let array = array_new(vec![10.0, 9.0, 1.0]);
    array_set_undefined(&array, 1.0);
    array_set_length(&array, 8.0);
    let alias = array.clone();
    array_sort_by_snapshot(&array, |left, right| {
        array_set_length(&alias, 1.0);
        left.partial_cmp(right).unwrap()
    });
    assert_eq!(array_len(&array), 3.0);
    assert_eq!(array_get(&array, 0.0), 1.0);
    assert_eq!(array_get(&array, 1.0), 10.0);
    assert_eq!(array_state(&array, 2.0), 2.0);
    drop((array, alias));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn mapped_shift_optional_mutates_the_shared_sparse_owner() {
    let source = array_new(vec![1.0, 2.0, 3.0]);
    array_delete(&source, 0.0);
    array_set_undefined(&source, 1.0);
    let view = array_mapped(source.clone(), mapped_number, mapped_string);
    assert_eq!(array_shift_optional(&view), None);
    assert_eq!((array_state(&source, 0.0), array_state(&source, 1.0)), (2.0, 1.0));
    assert_eq!(array_shift_optional(&view), None);
    assert_eq!(array_shift_optional(&view).as_deref(), Some("3"));
    assert_eq!(array_len(&source), 0.0);
}
