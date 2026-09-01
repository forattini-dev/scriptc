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
