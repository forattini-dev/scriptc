#[test]
fn module_namespace_matches_node24_index_and_utf16_order_and_has_no_prototype() {
    let namespace = map_new();
    for key in ["2", "10", "z", "\u{e000}", "\u{10000}", "01", "4294967295", "4294967294", "0"] {
        map_set_by(&namespace, string(key), 1.0, |left, right| left == right);
    }
    let ordinary = map_string_entries_js_order(&namespace);
    assert_eq!(ordinary[0].0.as_ref(), "0");
    map_set_prototype(&namespace, 4.0);
    map_mark_module_namespace(&namespace);
    assert!(map_is_module_namespace(&namespace));
    assert!(map_has_null_prototype(&namespace));
    assert!(map_prototype(&namespace).is_none());
    let keys = map_string_keys_js_order(&namespace);
    let actual: Vec<_> = (0..array_len(&keys) as usize)
        .map(|index| array_get(&keys, index as f64).to_string())
        .collect();
    // Node v24.15.0 Object.keys / Reflect.ownKeys / JSON.stringify agree
    // on this ordering. Leading zeros and 2^32 - 1 are names, not indexes.
    assert_eq!(actual, ["0", "2", "10", "4294967294", "01", "4294967295", "z", "\u{10000}", "\u{e000}"]);
}

#[test]
fn module_namespace_cannot_be_rewritten_extended_deleted_or_cleared() {
    let namespace = map_new();
    map_set_by(&namespace, string("count"), 1.0, |left, right| left == right);
    map_mark_module_namespace(&namespace);
    for key in ["count", "new"] {
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            map_set_by(&namespace, string(key), 2.0, |left, right| left == right);
        }));
        let error = caught_from_panic(attempt.expect_err("namespace assignment must fail"));
        assert!(caught_is_error(&error));
    }
    assert!(!map_delete_by(&namespace, &string("count"), |left, right| left == right));
    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| map_clear(&namespace)));
    let error = caught_from_panic(attempt.expect_err("namespace clear must fail"));
    assert!(caught_is_error(&error));
    assert_eq!(map_size(&namespace), 1.0);
    assert_eq!(map_get_by(&namespace, &string("count"), |left, right| left == right), Some(1.0));
}

#[test]
fn module_namespace_json_reads_each_export_without_holding_map_borrow() {
    struct NamespaceJsonProbe { values: JsMap<JsString, f64>, reads: Cell<usize> }
    impl JsonValue for NamespaceJsonProbe {
        fn write_json(&self, writer: &mut JsonWriter) {
            json_write_map_with(&self.values, writer, |_, _| {
                // A getter may enter code that mutably borrows its own
                // object metadata; the serializer must hold no map borrow.
                map_mark_null_prototype(&self.values);
                self.reads.set(self.reads.get() + 1);
                self.reads.get() as f64
            });
        }
    }
    let values = map_new();
    map_set_by(&values, string("count"), 0.0, |left, right| left == right);
    map_mark_module_namespace(&values);
    let probe = NamespaceJsonProbe { values, reads: Cell::new(0) };
    assert_eq!(json_stringify(&probe).as_ref(), "{\"count\":1}");
    assert_eq!(json_stringify(&probe).as_ref(), "{\"count\":2}");
    assert_eq!(probe.reads.get(), 2);
}
