/* The embedded module/edge tables the island resolves against. */

static TEST_MODULES: [IslandModule; 3] = [
    IslandModule {
        key: "/pkg/index.js",
        source: "module.exports = require('./inner.js');",
        format: IslandModuleFormat::Cjs,
        esm: Some("const m=globalThis.__scr_require(\"/pkg/index.js\");export default m;"),
    },
    IslandModule {
        key: "/pkg/inner.js",
        source: "module.exports = 7;",
        format: IslandModuleFormat::Cjs,
        esm: None,
    },
    IslandModule {
        key: "/pkg/meta.json",
        source: "{\"label\":\"v9\"}",
        format: IslandModuleFormat::Json,
        esm: None,
    },
];

static TEST_EDGES: [IslandEdge; 4] = [
    IslandEdge {
        from: "/pkg/index.js",
        specifier: "./inner.js",
        to: "/pkg/inner.js",
        kind: IslandEdgeKind::Any,
    },
    IslandEdge {
        from: "/pkg/index.js",
        specifier: "dual",
        to: "/dual/esm.mjs",
        kind: IslandEdgeKind::Import,
    },
    IslandEdge {
        from: "/pkg/index.js",
        specifier: "dual",
        to: "/dual/cjs.cjs",
        kind: IslandEdgeKind::Require,
    },
    IslandEdge {
        from: "/pkg/index.js",
        specifier: "onlyesm",
        to: "/onlyesm/index.mjs",
        kind: IslandEdgeKind::Import,
    },
];

fn with_tables<T>(body: impl FnOnce() -> T) -> T {
    island_register_modules(&TEST_MODULES);
    island_register_edges(&TEST_EDGES);
    let value = body();
    island_modules_reset();
    value
}

#[test]
fn island_module_lookup_finds_registered_keys() {
    with_tables(|| {
        let module = island_module_find("/pkg/index.js").expect("registered module");
        assert_eq!(module.format, IslandModuleFormat::Cjs);
        assert!(module.esm.is_some());
        assert_eq!(
            island_module_find("/pkg/meta.json").map(|m| m.format),
            Some(IslandModuleFormat::Json),
        );
        assert!(island_module_find("/pkg/absent.js").is_none());
    });
}

#[test]
fn island_any_edges_serve_both_call_forms() {
    with_tables(|| {
        for want in [IslandEdgeKind::Import, IslandEdgeKind::Require] {
            assert_eq!(
                island_edge_find("/pkg/index.js", "./inner.js", want),
                Some("/pkg/inner.js"),
            );
        }
    });
}

#[test]
fn island_dual_package_edges_split_by_call_form() {
    with_tables(|| {
        assert_eq!(
            island_edge_find("/pkg/index.js", "dual", IslandEdgeKind::Import),
            Some("/dual/esm.mjs"),
        );
        assert_eq!(
            island_edge_find("/pkg/index.js", "dual", IslandEdgeKind::Require),
            Some("/dual/cjs.cjs"),
        );
    });
}

#[test]
fn island_import_falls_back_to_a_require_edge_but_require_never_does() {
    static ONLY_REQUIRE: [IslandEdge; 1] = [IslandEdge {
        from: "/pkg/index.js",
        specifier: "lazy",
        to: "/lazy/index.cjs",
        kind: IslandEdgeKind::Require,
    }];
    island_register_edges(&ONLY_REQUIRE);
    assert_eq!(
        island_edge_find("/pkg/index.js", "lazy", IslandEdgeKind::Import),
        Some("/lazy/index.cjs"),
    );
    island_register_edges(&TEST_EDGES);
    assert_eq!(
        island_edge_find("/pkg/index.js", "onlyesm", IslandEdgeKind::Require),
        None,
    );
    island_modules_reset();
}

/* ── the require shim over the tables ──────────────────────────────── */

static REQUIRE_MODULES: [IslandModule; 4] = [
    IslandModule {
        key: "/pkg/broken.js",
        source: "module.exports = require('nope');",
        format: IslandModuleFormat::Cjs,
        esm: None,
    },
    IslandModule {
        key: "/pkg/index.js",
        source: "const inner = require('./inner.js');\n\
                 const meta = require('./meta.json');\n\
                 module.exports.describe = (a, b) => \
                 meta.label + ':' + inner.add(a, b) + ':' + __dirname;",
        format: IslandModuleFormat::Cjs,
        esm: None,
    },
    IslandModule {
        key: "/pkg/inner.js",
        source: "exports.add = (a, b) => a + b;",
        format: IslandModuleFormat::Cjs,
        esm: None,
    },
    IslandModule {
        key: "/pkg/meta.json",
        source: "{\"label\":\"pkg\"}",
        format: IslandModuleFormat::Json,
        esm: None,
    },
];

static REQUIRE_EDGES: [IslandEdge; 2] = [
    IslandEdge {
        from: "/pkg/index.js",
        specifier: "./inner.js",
        to: "/pkg/inner.js",
        kind: IslandEdgeKind::Any,
    },
    IslandEdge {
        from: "/pkg/index.js",
        specifier: "./meta.json",
        to: "/pkg/meta.json",
        kind: IslandEdgeKind::Any,
    },
];

fn with_require_realm<T>(body: impl FnOnce() -> T) -> T {
    island_register_modules(&REQUIRE_MODULES);
    island_register_edges(&REQUIRE_EDGES);
    let value = body();
    island_eval_finish();
    value
}

#[test]
fn island_require_walks_relative_edges_and_caches() {
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "const r = globalThis.__scr_require('/pkg/index.js');\
             r.describe(2, 3) + '|' + (globalThis.__scr_require('/pkg/index.js') === r)",
        ));
        assert_eq!(rendered.as_ref(), "pkg:5:/pkg|true");
    });
}

#[test]
fn island_require_of_an_unshimmed_builtin_reports_the_island_message() {
    // node:os is outside the island-js "rust" manifest — it needs a host
    // surface this island has not grown yet — so it is the fence the
    // shims deliberately do NOT remove. A builtin the manifest does list
    // (node:events) answers its shim instead; that is pinned end-to-end
    // in packages/compiler/test/emit-rust-island-shims.test.ts.
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "(() => { try { globalThis.__scr_require('node:os'); } \
             catch (e) { return e.message; } return 'no throw'; })()",
        ));
        assert_eq!(
            rendered.as_ref(),
            "the island does not provide the 'node:os' builtin",
        );
    });
}

#[test]
fn island_require_of_a_shimmed_builtin_answers_the_shim() {
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "globalThis.__scr_require('node:events').EventEmitter.name",
        ));
        assert_eq!(rendered.as_ref(), "EventEmitter");
    });
}

#[test]
fn island_require_of_an_unresolved_specifier_carries_nodes_shape() {
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "(() => { try { globalThis.__scr_require('/pkg/broken.js', '/pkg/index.js'); } \
             catch (e) { return e.code + '|' + e.requireStack.join(',') + '|' + e.message; } \
             return 'no throw'; })()",
        ));
        assert_eq!(
            rendered.as_ref(),
            "MODULE_NOT_FOUND|/pkg/broken.js,/pkg/index.js|Cannot find module 'nope'\n\
             Require stack:\n- /pkg/broken.js\n- /pkg/index.js",
        );
    });
}

#[test]
fn island_require_of_a_key_outside_the_table_is_not_embedded() {
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "(() => { try { globalThis.__scr_require('/pkg/absent.js'); } \
             catch (e) { return e.message; } return 'no throw'; })()",
        ));
        assert_eq!(rendered.as_ref(), "module '/pkg/absent.js' is not embedded");
    });
}

#[test]
fn island_require_forgets_a_module_whose_evaluation_threw() {
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "(() => { const attempt = () => { \
             try { globalThis.__scr_require('/pkg/broken.js'); return 'ok'; } \
             catch (e) { return e.code; } }; return attempt() + '|' + attempt(); })()",
        ));
        assert_eq!(rendered.as_ref(), "MODULE_NOT_FOUND|MODULE_NOT_FOUND");
    });
}

/* ── the host-call marshaling surfaces ─────────────────────────────── */

fn host_function(arity: usize, result: IslandHostResult) -> IslandValue {
    let slot = RefCell::new(Some(result));
    island_value_host_function(
        arity,
        Rc::new(move |_arguments| {
            slot.borrow_mut()
                .take()
                .expect("scriptc: host result taken twice")
        }),
    )
}

#[test]
fn island_host_results_marshal_by_kind() {
    let cases: Vec<(IslandHostResult, &str)> = vec![
        (IslandHostResult::Number(4.5), "4.5"),
        (IslandHostResult::Bool(true), "true"),
        (IslandHostResult::String(string("hi")), "hi"),
        (IslandHostResult::Undefined, "undefined"),
        (IslandHostResult::Null, "null"),
        (IslandHostResult::Bytes(vec![1, 2, 3]), "1,2,3"),
        (IslandHostResult::Json(string("{\"a\":[1,2]}")), "[object Object]"),
    ];
    for (result, rendered) in cases {
        let value = island_call(&host_function(0, result), &[]);
        assert_eq!(island_to_string(&value).as_ref(), rendered);
    }
    island_eval_finish();
}

#[test]
fn island_bytes_results_arrive_as_a_typed_array() {
    let value = island_call(&host_function(0, IslandHostResult::Bytes(vec![9, 8])), &[]);
    assert_eq!(island_to_string(&value).as_ref(), "9,8");
    assert_eq!(
        island_to_string(&island_get_property(&value, "length")).as_ref(),
        "2",
    );
    let constructor = island_get_property(&value, "constructor");
    assert_eq!(
        island_to_string(&island_get_property(&constructor, "name")).as_ref(),
        "Uint8Array",
    );
    island_eval_finish();
}

#[test]
fn island_json_results_deep_copy_into_the_realm() {
    let value = island_call(
        &host_function(0, IslandHostResult::Json(string("{\"a\":[1,2]}"))),
        &[],
    );
    assert_eq!(island_json(&value).as_ref(), "{\"a\":[1,2]}");
    island_eval_finish();
}

#[test]
fn island_host_arguments_exit_strictly_by_kind() {
    let echo = island_value_host_function(
        3,
        Rc::new(|arguments| {
            let count = island_host_argument_number(arguments, 0);
            let text = island_host_argument_string(arguments, 1);
            let flag = island_host_argument_bool(arguments, 2);
            IslandHostResult::String(string(&format!("{count}:{text}:{flag}")))
        }),
    );
    let value = island_call(
        &echo,
        &[
            island_value_number(2.5),
            island_value_string(&string("ab")),
            island_value_boolean(false),
        ],
    );
    assert_eq!(island_to_string(&value).as_ref(), "2.5:ab:false");
    island_eval_finish();
}

#[test]
fn island_bytes_arguments_copy_out_of_the_realm() {
    let produce = host_function(0, IslandHostResult::Bytes(vec![4, 5, 6]));
    let consume = island_value_host_function(
        1,
        Rc::new(|arguments| {
            let bytes = island_host_argument_bytes(arguments, 0);
            IslandHostResult::Number(bytes_len(&bytes) + bytes_get(&bytes, 0.0))
        }),
    );
    let produced = island_call(&produce, &[]);
    let value = island_call(&consume, &[produced]);
    assert_eq!(island_to_string(&value).as_ref(), "7");
    island_eval_finish();
}

#[test]
fn island_edge_lookup_misses_are_none() {
    with_tables(|| {
        assert_eq!(
            island_edge_find("/pkg/other.js", "./inner.js", IslandEdgeKind::Require),
            None,
        );
        assert_eq!(
            island_edge_find("/pkg/index.js", "./absent.js", IslandEdgeKind::Require),
            None,
        );
    });
}
