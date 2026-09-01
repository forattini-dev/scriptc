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
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "(() => { try { globalThis.__scr_require('node:events'); } \
             catch (e) { return e.message; } return 'no throw'; })()",
        ));
        assert_eq!(
            rendered.as_ref(),
            "the island does not provide the 'node:events' builtin",
        );
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
