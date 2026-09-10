// Run the same public import boundary on both supported island engines.
static BINDING_MODULES: [IslandModule; 1] = [IslandModule {
    key: "/binding-probe/index.mjs",
    source: b"globalThis.bindingEvaluations += 1; export const maybe = undefined; export const value = 42;",
    source_raw: 0,
    format: IslandModuleFormat::Esm,
    esm: None,
    esm_raw: 0,
}];

#[test]
fn island_static_binding_presence_precedes_evaluation_and_survives_cache_hits() {
    island_register_modules(&BINDING_MODULES);
    island_eval(&string("globalThis.bindingEvaluations = 0"));
    let key = string("/binding-probe/index.mjs");
    let specifier = string("binding-probe");
    // Two failed attempts must not evaluate the target or poison its cache.
    // Check again after successful evaluation to exercise the cached path.
    for initialized in [false, true] {
        for export in ["missing", "default"] {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                island_import_named(&key, &string(export), &specifier)
            }));
            let caught = caught_from_panic(result.err().expect("missing export must throw"));
            assert_eq!(caught_error_name(&caught).as_ref(), "SyntaxError");
            assert_eq!(caught_error_message(&caught).as_ref(), format!(
                "The requested module 'binding-probe' does not provide an export named '{export}'"
            ));
            assert_eq!(island_eval(&string("globalThis.bindingEvaluations")).as_ref(),
                if initialized { "1" } else { "0" });
        }
        let maybe = island_import_named(&key, &string("maybe"), &specifier);
        assert_eq!(island_value_typeof(&maybe).as_ref(), "undefined");
        let namespace = island_import_named(&key, &string("*"), &specifier);
        assert_eq!(island_to_string(&island_get_property(&namespace, "value")).as_ref(), "42");
        assert_eq!(island_eval(&string("globalThis.bindingEvaluations")).as_ref(), "1");
    }
    island_eval_finish();
    island_modules_reset();
}
