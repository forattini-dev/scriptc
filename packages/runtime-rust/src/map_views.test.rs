thread_local! { static MAP_VIEW_READS: Cell<usize> = const { Cell::new(0) }; }
fn map_view_number(value: f64) -> JsString {
    MAP_VIEW_READS.with(|reads| reads.set(reads.get() + 1));
    string(&format_number(value))
}
fn map_view_string(value: JsString) -> f64 { value.parse().expect("numeric test value") }

#[test]
fn mapped_maps_keep_storage_and_convert_only_accessed_values() {
    MAP_VIEW_READS.with(|reads| reads.set(0));
    let source = map_new();
    map_set_by(&source, string("count"), 1.0, |a, b| a == b);
    let view = map_mapped(source.clone(), map_view_number, map_view_string);
    let other = map_mapped(source.clone(), map_view_number, map_view_string);
    assert!(map_ptr_eq(&source, &view));
    assert!(map_ptr_eq(&view, &other));
    let restored = map_mapped_source::<_, f64, _>(&view).unwrap();
    assert!(source.ptr_eq(&restored));
    assert!(map_has_by(&view, &string("count"), |a, b| a == b));
    assert_eq!(array_join(&map_string_keys_js_order(&view), &string(",")).as_ref(), "count");
    MAP_VIEW_READS.with(|reads| assert_eq!(reads.get(), 0));
    assert_eq!(map_get_by(&view, &string("count"), |a, b| a == b).unwrap().as_ref(), "1");
    MAP_VIEW_READS.with(|reads| assert_eq!(reads.get(), 1));
    map_set_by(&other, string("count"), string("2"), |a, b| a == b);
    assert_eq!(map_get_by(&source, &string("count"), |a, b| a == b), Some(2.0));
    map_set_by(&source, string("new"), 3.0, |a, b| a == b);
    assert_eq!(json_stringify(&view).as_ref(), "{\"count\":\"2\",\"new\":\"3\"}");
    drop((source, view, other, restored));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn mapped_maps_share_tombstones_order_and_namespace_flags() {
    let source = map_new();
    for key in ["z", "2", "1", "a"] { map_set_by(&source, string(key), 1.0, |a, b| a == b); }
    let view = map_mapped(source.clone(), map_view_number, map_view_string);
    map_iter_enter(&view);
    assert!(map_delete_by(&source, &string("z"), |a, b| a == b));
    assert_eq!(map_iter_count(&view), 4.0);
    assert!(!map_iter_live(&view, 0.0));
    map_set_by(&view, string("z"), string("2"), |a, b| a == b);
    assert_eq!(map_size(&source), 4.0);
    map_iter_exit(&view);
    assert_eq!(map_iter_count(&view), 4.0);
    assert_eq!(array_join(&map_string_keys_js_order(&view), &string(",")).as_ref(), "1,2,a,z");
    map_set_prototype(&view, string("9"));
    assert_eq!(map_prototype(&source), Some(9.0));
    map_mark_null_prototype(&view);
    assert!(map_has_null_prototype(&source));
    map_mark_module_namespace(&view);
    assert!(map_is_module_namespace(&source));
    assert!(map_prototype(&view).is_none());
    assert!(!map_delete_by(&view, &string("z"), |a, b| a == b));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| map_clear(&view)));
    assert!(caught_is_error(&caught_from_panic(result.expect_err("namespace clear"))));
    drop((source, view));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[derive(Clone)]
struct MapViewCycle(JsMap<JsString, MapViewCycle>);
impl HeapValue for MapViewCycle {
    fn trace_value(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.0); }
}
impl JsonValue for MapViewCycle {
    fn write_json(&self, writer: &mut JsonWriter) { self.0.write_json(writer); }
}

#[test]
fn mapped_map_cycles_are_detected_and_collected() {
    let source = map_new();
    let view = map_mapped(source.clone(), |value| value, |value| value);
    map_set_by(&source, string("self"), MapViewCycle(view.clone()), |a, b| a == b);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| json_stringify(&view)));
    assert!(caught_is_error(&caught_from_panic(result.expect_err("cyclic map JSON"))));
    drop((source, view));
    assert_eq!(collect_cycles(), 2);
    finish();
    assert_eq!(live_heap_objects(), 0);
}
