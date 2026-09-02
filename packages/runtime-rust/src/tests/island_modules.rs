/* The embedded module/edge tables the island resolves against. */

static TEST_MODULES: [IslandModule; 5] = [
    IslandModule {
        key: "/pkg/timer.js",
        source: b"export function delay(ms, value) {\n  return new Promise((resolve) => setTimeout(() => resolve(value), ms));\n}",
        source_raw: 0,
        format: IslandModuleFormat::Esm,
        esm: None,
        esm_raw: 0,
    },
    IslandModule {
        key: "/pkg/index.js",
        source: b"module.exports = require('./inner.js');",
        source_raw: 0,
        format: IslandModuleFormat::Cjs,
        esm: Some(b"const m=globalThis.__scr_require(\"/pkg/index.js\");export default m;"),
        esm_raw: 0,
    },
    IslandModule {
        key: "/pkg/inner.js",
        source: b"module.exports = 7;",
        source_raw: 0,
        format: IslandModuleFormat::Cjs,
        esm: None,
        esm_raw: 0,
    },
    IslandModule {
        key: "/pkg/meta.json",
        source: b"{\"label\":\"v9\"}",
        source_raw: 0,
        format: IslandModuleFormat::Json,
        esm: None,
        esm_raw: 0,
    },
    IslandModule {
        key: "/pkg/import-meta.mjs",
        source: b"export const url = import.meta.url;",
        source_raw: 0,
        format: IslandModuleFormat::Esm,
        esm: None,
        esm_raw: 0,
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
        source: b"module.exports = require('nope');",
        source_raw: 0,
        format: IslandModuleFormat::Cjs,
        esm: None,
        esm_raw: 0,
    },
    IslandModule {
        key: "/pkg/index.js",
        source: b"const inner = require('./inner.js');\n\
                 const meta = require('./meta.json');\n\
                 module.exports.describe = (a, b) => \
                 meta.label + ':' + inner.add(a, b) + ':' + __dirname;",
        source_raw: 0,
        format: IslandModuleFormat::Cjs,
        esm: None,
        esm_raw: 0,
    },
    IslandModule {
        key: "/pkg/inner.js",
        source: b"exports.add = (a, b) => a + b;",
        source_raw: 0,
        format: IslandModuleFormat::Cjs,
        esm: None,
        esm_raw: 0,
    },
    IslandModule {
        key: "/pkg/meta.json",
        source: b"{\"label\":\"pkg\"}",
        source_raw: 0,
        format: IslandModuleFormat::Json,
        esm: None,
        esm_raw: 0,
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
fn island_require_of_net_exposes_socket_function_shape() {
    // Package bundles often import node:net during module initialization
    // without opening a socket on the selected command. The shim exposes
    // Node's function shape, while its call remains an explicit fence until
    // asynchronous sockets can run inside the island.
    with_require_realm(|| {
        let rendered = island_eval(&string(
            "typeof globalThis.__scr_require('node:net').createConnection",
        ));
        assert_eq!(rendered.as_ref(), "function");
    });
}

#[test]
fn island_timeout_unref_updates_native_liveness() {
    let rendered = with_require_realm(|| {
        island_eval(&string(
            "(() => { const timer = setInterval(() => {}, 1000); \
             const before = timer.hasRef(); timer.unref(); \
             const after = timer.hasRef(); clearInterval(timer); \
             return before + '|' + after; })()",
        ))
    });
    assert_eq!(rendered.as_ref(), "true|false");
}

#[test]
fn external_module_with_many_builtin_imports_links_once() {
    struct TempModule(std::path::PathBuf);
    impl Drop for TempModule {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    let path = std::env::temp_dir().join(format!(
        "scriptc-island-many-imports-{}.mjs",
        std::process::id(),
    ));
    let file = TempModule(path);
    let mut source = String::new();
    for index in 0..32 {
        source.push_str(&format!(
            "import {{ basename as path{index} }} from 'node:path';\n",
        ));
    }
    source.push_str(
        "import { EventEmitter } from 'node:events';\n\
         import { readFileSync } from 'node:fs';\n\
         import { readFile } from 'node:fs/promises';\n\
         import { basename } from 'node:path';\n\
         import { fileURLToPath } from 'node:url';\n\
         import { createHash } from 'node:crypto';\n\
         import { createInterface } from 'node:readline';\n\
         export const metaUrl = import.meta.url;\n\
         export const ready = [EventEmitter, readFileSync, readFile, basename, \
           fileURLToPath, createHash, createInterface].every(x => typeof x === 'function');",
    );
    std::fs::write(&file.0, source).expect("write external module fixture");
    let specifier = string(url::Url::from_file_path(&file.0).unwrap().as_str());

    let (ready, meta_url) = with_require_realm(|| {
        let promise = island_import_dyn_path(&specifier);
        let namespace = island_await(&promise);
        (
            island_to_string(&island_get_property(&namespace, "ready")),
            island_to_string(&island_get_property(&namespace, "metaUrl")),
        )
    });
    assert_eq!(ready.as_ref(), "true");
    assert_eq!(meta_url, specifier);
}

#[test]
fn island_modules_expose_their_file_url_through_import_meta() {
    with_tables(|| {
        let url = island_import(
            &JsString::from("/pkg/import-meta.mjs"),
            &JsString::from("url"),
        );
        assert_eq!(island_to_string(&url).as_ref(), "file:///pkg/import-meta.mjs");
    });
    island_eval_finish();
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

/* ── boa 0.22.0 defects, pinned as the behavior we WANT ────────────────
 *
 * Both tests below assert V8's answer, which is what Node produces and
 * what a program compiled against the island has every right to expect.
 * They fail today against boa 0.22.0 and are ignored rather than deleted
 * so they turn green by themselves once the engine is fixed. The
 * divergence is written up for upstream in
 * docs/upstream/boa-to-json-drops-typed-array-elements.md.
 *
 * Run them with `--ignored` today and the process ABORTS rather than
 * printing an assertion diff. That is not these tests misbehaving: any
 * panic unwinding out of a live island corrupts the heap, which is a
 * separate scriptc-side defect isolated in
 * docs/upstream/boa-suspected-aborts-are-not-upstream.md. Once the engine
 * is fixed these assertions hold, nothing panics, and the abort is moot. */

#[test]
#[ignore = "boa 0.22.0 serializes every typed array as {} — JsValue::to_json \
            drops the elements; see docs/upstream/\
            boa-to-json-drops-typed-array-elements.md"]
fn island_json_serializes_typed_array_elements() {
    // A typed array's indices are own enumerable properties, so
    // JSON.stringify walks them: Node answers {"0":1,"1":2,"2":3}. boa
    // answers {} — silently, with Ok(Some(..)), which is what makes the
    // loss surface far from its cause.
    island_eval(&string("globalThis.probe = new Uint8Array([1,2,3]); 0"));
    let value = island_global_get("probe");
    assert_eq!(island_json(&value).as_ref(), "{\"0\":1,\"1\":2,\"2\":3}");
    island_eval_finish();
}

#[test]
#[ignore = "boa 0.22.0 does not invoke toJSON from JsValue::to_json (no \
            JavaScript runs during serialization); see docs/upstream/\
            boa-to-json-drops-typed-array-elements.md"]
fn island_json_honors_a_to_json_method() {
    // Node answers "\"TJ\"". boa serializes the method as an ordinary
    // property instead of calling it.
    island_eval(&string(
        "globalThis.probe = { a: 1 }; globalThis.probe.toJSON = () => 'TJ'; 0",
    ));
    let value = island_global_get("probe");
    assert_eq!(island_json(&value).as_ref(), "\"TJ\"");
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

/// A promise ONLY a timer can settle resolves through `island_await`.
///
/// Module evaluation runs before `run_event_loop` starts, so before the
/// timer bridge existed this shape had no native event source capable of
/// advancing it and reached ERR_MODULE_PROMISE_PENDING. The await now
/// drops the ISLAND_STATE borrow between probes and pumps the timer
/// phase — which is also what lets the timer callback re-enter the realm.
#[test]
fn island_await_settles_a_promise_only_a_timer_can_resolve() {
    with_tables(|| {
        let delay = island_import(&JsString::from("/pkg/timer.js"), &JsString::from("delay"));
        let pending = island_call(&delay, &[island_value_number(5.0), island_value_number(42.0)]);
        let settled = island_await(&pending);
        assert_eq!(island_to_string(&settled).as_ref(), "42");
    });
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

/* ── panic hardening ───────────────────────────────────────────────── */

/// A genuine Rust panic reached while the island realm is active (an
/// `assert!` failure inside code that entered the island, not a scriptc
/// `throw`) must surface with its OWN message and leave the realm torn
/// down and safely rebuildable -- not corrupt `ISLAND_STATE` for whatever
/// runs next.
///
/// This is `with_island_state`'s catch/resume boundary from island_eval.rs
/// exercised directly: before it existed, the panicking `RefMut` borrow
/// simply released on unwind without dropping the `IslandState` it guarded,
/// so the SAME (possibly mid-mutation) realm silently kept serving later
/// calls, and it was only torn down much later at uncontrolled thread-exit
/// -- which is where the original bug turned into a glibc heap-corruption
/// abort that buried this very message.
#[test]
fn island_panic_gets_orderly_teardown_not_left_for_thread_exit() {
    island_eval(&string("globalThis.marker = 1;"));

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        with_island_state(|_state| {
            assert_eq!(1, 2, "island hardening probe");
        });
    }));
    let message = outcome.err().and_then(|payload| {
        payload.downcast_ref::<String>().cloned().or_else(|| {
            payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_owned())
        })
    });
    assert!(
        message.is_some_and(|message| message.contains("island hardening probe")),
        "expected the assertion's own message to survive the unwind, not a masked abort"
    );

    // A pre-fix realm would still answer "number" here: the old marker
    // survived because nothing ever dropped the mid-panic IslandState.
    let rendered = island_eval(&string("typeof globalThis.marker"));
    assert_eq!(rendered.as_ref(), "undefined");
    let rendered = island_eval(&string("1 + 1"));
    assert_eq!(rendered.as_ref(), "2");
    island_eval_finish();
}

/// A scriptc `throw` (the runtime's OWN panic-based control flow) crossing
/// this same boundary is expected, not a defect: the realm's globals must
/// survive so a later `island_eval` after the catch sees them, exactly
/// like Node's `try { throw x } catch {}` followed by more code in the
/// same module scope.
#[test]
fn island_scriptc_throw_leaves_the_realm_intact() {
    island_eval(&string("globalThis.marker = 'kept';"));

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        island_eval(&string("throw new TypeError('expected')"));
    }));
    assert!(
        outcome.is_err(),
        "the island throw must still unwind the call"
    );

    let rendered = island_eval(&string("globalThis.marker"));
    assert_eq!(rendered.as_ref(), "kept");
    island_eval_finish();
}

/* ── DEFLATE-stored module texts ───────────────────────────────────────
 *
 * A `--dynamic` build embeds every reached npm source, so the module
 * table is the dominant term in the binary's size. Texts at or above the
 * compiler's NPM_COMPRESS_MIN are embedded as raw DEFLATE — the same rule
 * and the same stream format the C lane uses — with the row carrying the
 * inflated length; the runtime inflates on first use and caches. */

#[test]
fn a_deflated_module_text_inflates_on_first_use_and_is_cached() {
    let text = "export const parts = [\n".to_owned()
        + &"  \"an embedded module payload line\",\n".repeat(64)
        + "];\n";
    assert!(text.len() >= 1024, "the fixture must clear NPM_COMPRESS_MIN");
    let stored: &'static [u8] = Vec::leak(zlib_compress_bytes(text.as_bytes(), false));
    assert!(
        stored.len() < text.len(),
        "the fixture must actually compress: {} >= {}",
        stored.len(),
        text.len(),
    );
    let module = IslandModule {
        key: "/pkg/deflated.mjs",
        source: stored,
        source_raw: text.len(),
        format: IslandModuleFormat::Esm,
        esm: None,
        esm_raw: 0,
    };

    let first = island_module_source(&module);
    assert_eq!(first, text);
    // The second read is served from the cache rather than inflated
    // again — the same allocation, which is what keeps a require loop
    // over one hot module cheap.
    let second = island_module_source(&module);
    assert_eq!(second.as_ptr(), first.as_ptr());
}

#[test]
fn a_deflated_esm_facade_inflates_independently_of_the_source() {
    let source = "module.exports = { tag: \"cjs\" };\n".repeat(64);
    let facade =
        "const m = globalThis.__scr_require(\"/pkg/dual.js\");\nexport default m;\n".repeat(32);
    let module = IslandModule {
        key: "/pkg/dual.js",
        source: Vec::leak(zlib_compress_bytes(source.as_bytes(), false)),
        source_raw: source.len(),
        format: IslandModuleFormat::Cjs,
        esm: Some(Vec::leak(zlib_compress_bytes(facade.as_bytes(), false))),
        esm_raw: facade.len(),
    };
    assert_eq!(island_module_source(&module), source);
    assert_eq!(island_module_esm(&module), Some(facade.as_str()));
    // A CJS module enters the ES graph through its facade, never through
    // its source — so the two stored texts must not be confusable.
    assert_eq!(island_module_esm_source(&module), facade);
}

#[test]
fn a_plain_stored_module_text_is_read_without_inflating() {
    // Below NPM_COMPRESS_MIN the compiler stores the bytes verbatim and
    // marks the row with raw = 0; the reader must take them as the text.
    let module = IslandModule {
        key: "/pkg/small.mjs",
        source: b"export const value = 1;\n",
        source_raw: 0,
        format: IslandModuleFormat::Esm,
        esm: None,
        esm_raw: 0,
    };
    assert_eq!(island_module_source(&module), "export const value = 1;\n");
    assert_eq!(island_module_esm(&module), None);
}
