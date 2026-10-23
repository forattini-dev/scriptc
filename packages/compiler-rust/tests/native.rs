//! Node is exclusively the differential oracle, never a compiler dependency.
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn compiler() -> &'static str {
    // A frozen compiler lets a long differential run keep one implementation
    // and runtime snapshot while development continues in the checkout.
    static COMPILER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    COMPILER
        .get_or_init(|| {
            std::env::var("SCRIPTC_NATIVE_COMPILER_BIN")
                .unwrap_or_else(|_| env!("CARGO_BIN_EXE_scriptc").into())
        })
        .as_str()
}
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn binary(dir: &Path, name: &str) -> PathBuf {
    dir.join(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    })
}
fn oracle() -> String {
    std::env::var("SCRIPTC_NODE_ORACLE").unwrap_or_else(|_| "node".into())
}
fn process_environment(case: &str, building: bool) -> Vec<(&'static str, &'static str)> {
    if case.starts_with("rust-native-conditional-require/") {
        return vec![(
            "SCRIPTC_NATIVE_REQUIRE_SIDE",
            if building { "right" } else { "left" },
        )];
    }
    if !case.starts_with("rust-native-process/") {
        return vec![];
    }
    vec![
        (
            "SCRIPTC_NATIVE_PROCESS_VALUE",
            if building {
                "compile-value"
            } else {
                "runtime-value"
            },
        ),
        (
            "SCRIPTC_NATIVE_PROCESS_EMPTY",
            if building { "compile-value" } else { "" },
        ),
    ]
}
fn success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn ts_and_js_execute_like_node_without_a_javascript_compiler() {
    let version = Command::new(oracle())
        .arg("--version")
        .output()
        .expect("Node oracle is required only for this test");
    success(&version);
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "v24.15.0",
        "use the pinned SCRIPTC_NODE_ORACLE"
    );
    let temp = tempfile::tempdir().unwrap();
    // Real executable traps catch accidental Node/Go/tsc process launches on
    // Windows as well as Unix. The Rust toolchain remains on PATH.
    let traps = temp.path().join("traps");
    fs::create_dir(&traps).unwrap();
    let trap_source = temp.path().join("trap.rs");
    fs::write(&trap_source, "fn main() { std::fs::write(std::env::var(\"SCRIPTC_FORBIDDEN_MARKER\").unwrap(), b\"called\").unwrap(); std::process::exit(99); }").unwrap();
    let trap = binary(temp.path(), "trap");
    success(
        &Command::new("rustc")
            .arg(&trap_source)
            .arg("-o")
            .arg(&trap)
            .output()
            .unwrap(),
    );
    for name in ["node", "go", "tsgo", "tsc", "bun"] {
        fs::copy(&trap, binary(&traps, name)).unwrap();
    }
    let helper = binary(temp.path(), "exec-file-helper");
    success(
        &Command::new("rustc")
            .arg(root().join("tests/fixtures/native-exec-file-helper.rs"))
            .arg("-o")
            .arg(&helper)
            .output()
            .unwrap(),
    );
    let marker = temp.path().join("forbidden-called");
    let mut paths = vec![traps];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    let path = std::env::join_paths(paths).unwrap();
    for (index, name) in [
        "rust-native-platform/mkdir.ts",
        "rust-native-platform/paths.ts",
        "rust-native-platform/crypto.ts",
        "rust-native-platform/stats.ts",
        "rust-native-platform/stat-errors.ts",
        "rust-native-primitives/array-brand.ts",
        "rust-native-primitives/augmented-standard.ts",
        "rust-native-primitives/string-function.ts",
        "rust-native-primitives/opaque-objects.ts",
        "rust-native-primitives/string-addition.ts",
        "rust-native-primitives/json-presence.ts",
        "rust-native-primitives/raw-json.ts",
        "rust-native-primitives/object-methods.ts",
        "rust-native-primitives/object-method-rest.ts",
        "rust-native-primitives/raw-json-plain.js",
        "rust-native-primitives/opaque-maps.ts",
        "rust-native-primitives/conditions.ts",
        "rust-native-primitives/math-functions.ts",
        "rust-native-primitives/strings.ts",
        "rust-native-primitives/utf16.ts",
        "rust-native-primitives/math.ts",
        "rust-native-primitives/repeat.ts",
        "rust-native-primitives/order.ts",
        "rust-native-primitives/errors.ts",
        "rust-native-primitives/shadows.ts",
        "rust-native-primitives/contracts.ts",
        "rust-native-receivers/strict.cjs",
        "rust-native-receivers/call.ts",
        "rust-native-receivers/lexical.ts",
        "rust-native-receivers/effects.ts",
        "rust-native-receivers/rest.ts",
        "rust-native-receivers/json.ts",
        "rust-native-receivers/contracts.ts",
        "rust-native-logical/values.ts",
        "rust-native-logical/identity.ts",
        "rust-native-logical/effects.ts",
        "rust-native-logical/guards.ts",
        "rust-native-logical/mutations.ts",
        "rust-native-logical/void.js",
        "rust-native-json-functions/identity.ts",
        "rust-native-json-functions/values.ts",
        "rust-native-json-functions/parse.ts",
        "rust-native-json-functions/replacer.ts",
        "rust-native-json-functions/hooks.ts",
        "rust-native-json-functions/shadows.ts",
        "rust-native-json-functions/omission.js",
        "rust-native-exec-file/identity.ts",
        "rust-native-exec-file/success.ts",
        "rust-native-exec-file/errors.ts",
        "rust-native-exec-file/limits.ts",
        "rust-native-exec-file/callbacks.ts",
        "rust-native-exec-file/validation.ts",
        "rust-native-exec-file/callback-errors.ts",
        "rust-native-exec-file/options.ts",
        "rust-native-exec-file/properties.ts",
        "rust-native-recursive-values/equivalent.ts",
        "rust-native-recursive-values/equivalent-nullable.ts",
        "rust-native-recursive-values/equivalent-mutual.ts",
        "rust-native-recursive-values/equivalent-unions.ts",
        "rust-native-recursive-values/main.ts",
        "rust-native-recursive-values/mutual.ts",
        "rust-native-recursive-values/json.ts",
        "rust-native-recursive-values/empty.ts",
        "rust-native-recursive-values/contracts.ts",
        "rust-native-recursive-values/checked.ts",
        "rust-native-recursive-values/dictionary.ts",
        "rust-native-private-methods/main.ts",
        "rust-native-private-methods/brands.ts",
        "rust-native-private-methods/order.ts",
        "rust-native-private-methods/inheritance.ts",
        "rust-native-private-methods/deferred.ts",
        "rust-native-private-methods/identity.ts",
        "rust-native-private-methods/modules.ts",
        "rust-native-private-methods/untyped.js",
        "rust-native-private/main.ts",
        "rust-native-private/fields.ts",
        "rust-native-private/brand.ts",
        "rust-native-private/order.ts",
        "rust-native-private/inheritance.ts",
        "rust-native-private/identity.ts",
        "rust-native-private/modules.ts",
        "rust-native-private/untyped.js",
        "rust-native-accessors/main.ts",
        "rust-native-accessors/inheritance.ts",
        "rust-native-accessors/order.ts",
        "rust-native-accessors/contracts.ts",
        "rust-native-accessors/untyped.js",
        "rust-native-accessors/identity.ts",
        "rust-native-file-urls/paths.ts",
        "rust-native-file-urls/errors.ts",
        "rust-native-file-urls/metadata.ts",
        "rust-native-file-urls/modules.ts",
        "rust-native-file-urls/order.ts",
        "rust-native-file-urls/untyped.js",
        "rust-native-frontend/main.ts",
        "rust-native-frontend/numbers.ts",
        "rust-native-frontend/plain.js",
        "rust-native-functions/main.ts",
        "rust-native-modules/main.ts",
        "rust-native-project/main.ts",
        "rust-native-builtins/main.ts",
        "rust-native-package/main.ts",
        "rust-native-json/main.ts",
        "rust-native-builtins/runtime-types-only.ts",
        "rust-native-builtins/process-import.ts",
        "rust-native-cycles/main.ts",
        "rust-native-records/main.ts",
        "rust-native-records/runtime-types-only.ts",
        "rust-native-callbacks/main.ts",
        "rust-native-callbacks/runtime-types-only.ts",
        "rust-native-js-contracts/contracts.ts",
        "rust-native-parameters/main.ts",
        "rust-native-parameters/function-values.ts",
        "rust-native-collections/main.ts",
        "rust-native-collections/scalar-map.ts",
        "rust-native-collections/runtime-types-only.ts",
        "rust-native-reachability/main.ts",
        "rust-native-storage/main.ts",
        "rust-native-storage/cycle.ts",
        "rust-native-storage/namespace.ts",
        "rust-native-map-seeds/main.ts",
        "rust-native-map-seeds/order.ts",
        "rust-native-map-seeds/contracts.ts",
        "rust-native-errors/main.ts",
        "rust-native-errors/contracts.ts",
        "rust-native-regex/main.ts",
        "rust-native-regex/contracts.ts",
        "rust-native-vars/main.ts",
        "rust-native-vars/cycle.ts",
        "rust-native-vars/contracts.ts",
        "rust-native-class-values/main.ts",
        "rust-native-class-values/contracts.ts",
        "rust-native-enums/main.ts",
        "rust-native-callables/contracts.ts",
        "rust-native-callables/cycles.ts",
        "rust-native-callable-contracts/imports.ts",
        "rust-native-callable-contracts/contracts.ts",
        "rust-native-erased/contracts.ts",
        "rust-native-erased/classes.ts",
        "rust-native-erased/boundaries.ts",
        "rust-native-erased/generic-endpoint.ts",
        "rust-native-erased/error-values.ts",
        "rust-native-map-values/contracts.ts",
        "rust-native-map-values/hoisting.js",
        "rust-native-map-values/seeds.ts",
        "rust-native-property-keys/contracts.ts",
        "rust-native-promises/contracts.ts",
        "rust-native-promises/order.ts",
        "rust-native-promises/values.ts",
        "rust-native-promises/resolve-only.ts",
        "rust-native-union-literals/contracts.ts",
        "rust-native-union-literals/checked.ts",
        "rust-native-generic-errors/contracts.ts",
        "rust-native-strings/templates.ts",
        "rust-native-strings/joins.ts",
        "rust-native-strings/order.ts",
        "rust-native-tuple-rest/contracts.ts",
        "rust-native-sets/contracts.ts",
        "rust-native-sets/seeds.ts",
        "rust-native-sets/order.ts",
        "rust-native-data-tables/contracts.ts",
        "rust-native-data-tables/plain.js",
        "rust-native-process/reads.ts",
        "rust-native-process/imports.ts",
        "rust-native-process/shadows.ts",
        "rust-native-process/architecture.ts",
        "rust-native-process/architecture.cjs",
        "rust-native-namespaces/storage.ts",
        "rust-native-namespaces/order.ts",
        "rust-native-namespaces/cycles.ts",
        "rust-native-namespaces/tdz.ts",
        "rust-native-default-values/values.ts",
        "rust-native-default-values/order.ts",
        "rust-native-default-values/captures.ts",
        "rust-native-default-values/process.ts",
        "rust-native-unit-caches/values.js",
        "rust-native-unit-caches/ownership.js",
        "rust-native-unit-caches/order.js",
        "rust-native-unit-caches/cycles.js",
        "rust-native-unit-caches/contracts.ts",
        "rust-native-weak-maps/identity.ts",
        "rust-native-weak-maps/order.ts",
        "rust-native-weak-maps/values.ts",
        "rust-native-weak-maps/untyped.js",
        "rust-native-weak-maps/shadows.ts",
        "rust-native-weak-maps/modules.ts",
        "rust-native-set-values/identity.ts",
        "rust-native-set-values/callbacks.ts",
        "rust-native-set-values/dynamic.ts",
        "rust-native-set-values/seeds.ts",
        "rust-native-set-values/order.ts",
        "rust-native-set-values/untyped.js",
        "rust-native-async-context/scalars.ts",
        "rust-native-async-context/order.ts",
        "rust-native-async-context/exceptions.ts",
        "rust-native-async-context/promises.ts",
        "rust-native-async-context/ownership.ts",
        "rust-native-async-context/shadows.ts",
        "rust-native-async-context/untyped.js",
        "rust-native-lexicals/values.ts",
        "rust-native-lexicals/deferred.ts",
        "rust-native-lexicals/completions.ts",
        "rust-native-lexicals/interruptions.ts",
        "rust-native-lexicals/deferred-order.ts",
        "rust-native-lexicals/order.ts",
        "rust-native-lexicals/cycles.ts",
        "rust-native-lexicals/plain.js",
        "rust-native-async/prefix.ts",
        "rust-native-async/exceptions.ts",
        "rust-native-async/closures.ts",
        "rust-native-async/reactions.ts",
        "rust-native-satisfies/values.ts",
        "rust-native-satisfies/context.ts",
        "rust-native-satisfies/order.ts",
        "rust-native-commonjs/order.ts",
        "rust-native-commonjs/cycles.ts",
        "rust-native-commonjs/replacement.ts",
        "rust-native-commonjs/named.ts",
        "rust-native-commonjs/cjs/entry.js",
        "rust-native-commonjs/snapshots.ts",
        "rust-native-commonjs/cjs/cache.cjs",
        "rust-native-commonjs/cjs/builtins.js",
        "rust-native-conditions/callbacks.ts",
        "rust-native-conditions/live.js",
        "rust-native-conditions/values.ts",
        "rust-native-spreads/providers.ts",
        "rust-native-record-views/providers.ts",
        "rust-native-record-views/aliases.ts",
        "rust-native-record-views/keys.ts",
        "rust-native-record-views/unions.ts",
        "rust-native-record-views/order.ts",
        "rust-native-record-views/contracts.ts",
        "rust-native-union-spreads/providers.ts",
        "rust-native-union-spreads/order.ts",
        "rust-native-union-spreads/identity.ts",
        "rust-native-union-spreads/keys.ts",
        "rust-native-union-spreads/collapsed.ts",
        "rust-native-union-spreads/contracts.ts",
        "rust-native-record-build/builders.ts",
        "rust-native-record-build/order.ts",
        "rust-native-record-build/identity.ts",
        "rust-native-record-build/keys.ts",
        "rust-native-record-build/exceptions.ts",
        "rust-native-record-build/contracts.ts",
        "rust-native-array-rest/builders.ts",
        "rust-native-array-rest/calls.ts",
        "rust-native-array-rest/ownership.ts",
        "rust-native-array-rest/erasure-bind.ts",
        "rust-native-array-rest/contracts.ts",
        "rust-native-array-rest/order.ts",
        "rust-native-spreads/order.ts",
        "rust-native-spreads/presence.ts",
        "rust-native-spreads/keys.ts",
        "rust-native-spreads/contracts.ts",
        "rust-native-spreads/exceptions.ts",
        "rust-native-console/node-types/contracts.ts",
        "rust-native-console/declaration-types.ts",
        "rust-native-console/callbacks.ts",
        "rust-native-console/identity.ts",
        "rust-native-console/order.ts",
        "rust-native-console/shadows.ts",
        "rust-native-console/contracts.ts",
        "rust-native-codecs/containers.ts",
        "rust-native-codecs/shadows.ts",
        "rust-native-codecs/utf8.ts",
        "rust-native-codecs/identity.ts",
        "rust-native-codecs/order.ts",
        "rust-native-symbols/sentinels.js",
        "rust-native-symbols/registry.ts",
        "rust-native-symbols/containers.ts",
        "rust-native-symbols/erased.ts",
        "rust-native-symbol-methods/calls.ts",
        "rust-native-symbol-methods/private.ts",
        "rust-native-symbol-methods/inheritance.ts",
        "rust-native-symbol-methods/order.ts",
        "rust-native-symbol-methods/deferred.ts",
        "rust-native-symbol-methods/untyped.js",
        "rust-native-well-known-symbols/identity.ts",
        "rust-native-well-known-symbols/storage.ts",
        "rust-native-well-known-symbols/modules.ts",
        "rust-native-well-known-symbols/shadows.ts",
        "rust-native-well-known-symbols/untyped.js",
        "rust-native-methods/direct.ts",
        "rust-native-methods/dispatch.ts",
        "rust-native-methods/contracts.ts",
        "rust-native-methods/errors.ts",
        "rust-native-methods/deferred.ts",
        "rust-native-classes/objects.ts",
        "rust-native-classes/order.ts",
        "rust-native-classes/exceptions.ts",
        "rust-native-classes/contracts.ts",
        "rust-native-classes/shadows.ts",
        "rust-native-exceptions/control.ts",
        "rust-native-exceptions/override.ts",
        "rust-native-exceptions/values.ts",
        "rust-native-exceptions/errors.ts",
        "rust-native-exceptions/payloads.ts",
        "rust-native-exceptions/wrapper.cjs",
        "rust-native-conditional-require/entry.cjs",
        "rust-native-conditional-require/assignments.cjs",
        "rust-native-conditional-require/blocks.cjs",
        "rust-native-conditional-require/cycles.cjs",
        "rust-native-json-require/objects.cjs",
        "rust-native-json-require/roots.cjs",
        "rust-native-json-require/numbers.cjs",
        "rust-native-json-require/esm/consumer.ts",
    ]
    .into_iter()
    .enumerate()
    {
        let input = root().join("tests/corpus").join(name);
        // Keep this program's artifacts through every assertion, then release
        // them before the next program instead of accumulating the whole corpus.
        let artifacts = tempfile::tempdir_in(temp.path()).unwrap();
        let target = binary(artifacts.path(), &format!("case-{index}"));
        // Filesystem fixtures must not share state between Node and native.
        let oracle_cwd = artifacts.path().join("oracle-cwd");
        let native_cwd = artifacts.path().join("native-cwd");
        let isolated = name.starts_with("rust-native-platform/");
        if isolated {
            fs::create_dir(&oracle_cwd).unwrap();
            fs::create_dir(&native_cwd).unwrap();
        }
        let normal_cwd = std::env::current_dir().unwrap();
        let expected = Command::new(oracle())
            .env("SCRIPTC_EXEC_FILE_HELPER", &helper)
            .arg(&input)
            .envs(process_environment(name, false))
            .env_remove("SCRIPTC_NATIVE_PROCESS_MISSING")
            .current_dir(if isolated { &oracle_cwd } else { &normal_cwd })
            .output()
            .unwrap();
        success(&expected);
        let build = Command::new(compiler())
            .env("SCRIPTC_EXEC_FILE_HELPER", &helper)
            .args(["build"])
            .arg(&input)
            .arg("--out")
            .arg(&target)
            .env("PATH", &path)
            .env("SCRIPTC_FORBIDDEN_MARKER", &marker)
            .envs(process_environment(name, true))
            .env("SCRIPTC_NATIVE_PROCESS_MISSING", "compile-value")
            .output()
            .unwrap();
        success(&build);
        let metadata: serde_json::Value = serde_json::from_slice(&build.stdout).unwrap();
        assert_eq!(metadata["compiler"], "rust");
        assert_eq!(metadata["engine"], "none");
        assert_eq!(metadata["externalFfi"], false);
        assert_eq!(metadata["irVersion"], 13);
        assert_eq!(
            metadata["frontendRevision"],
            "780dc512d64f40afebffa6a7028207649fb7ed1c"
        );
        let actual = Command::new(&target)
            .env("SCRIPTC_EXEC_FILE_HELPER", &helper)
            .env("PATH", &path)
            .env("SCRIPTC_FORBIDDEN_MARKER", &marker)
            .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
            .envs(process_environment(name, false))
            .env_remove("SCRIPTC_NATIVE_PROCESS_MISSING")
            .current_dir(if isolated { &native_cwd } else { &normal_cwd })
            .output()
            .unwrap();
        assert_eq!(actual.status.code(), expected.status.code(), "{name}");
        assert_eq!(actual.stdout, expected.stdout, "stdout: {name}");
        assert_eq!(actual.stderr, expected.stderr, "stderr: {name}");
        if name.starts_with("rust-native-conditional-require/") {
            let expected = Command::new(oracle())
                .arg(&input)
                .env("SCRIPTC_NATIVE_REQUIRE_SIDE", "right")
                .output()
                .unwrap();
            success(&expected);
            let actual = Command::new(&target)
                .env("PATH", &path)
                .env("SCRIPTC_FORBIDDEN_MARKER", &marker)
                .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
                .env("SCRIPTC_NATIVE_REQUIRE_SIDE", "right")
                .output()
                .unwrap();
            assert_eq!(
                actual.status.code(),
                expected.status.code(),
                "{name}: right branch"
            );
            assert_eq!(
                actual.stdout, expected.stdout,
                "{name}: right branch stdout"
            );
            assert_eq!(
                actual.stderr, expected.stderr,
                "{name}: right branch stderr"
            );
        }
        assert!(
            !marker.exists(),
            "a forbidden compiler/runtime process was invoked"
        );
        let ir: serde_json::Value =
            serde_json::from_slice(&fs::read(target.with_extension("ir.json")).unwrap()).unwrap();
        assert_eq!(ir["irVersion"], 13);
        if name.starts_with("rust-native-private-methods/") {
            let demanded = ir["functions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|function| function["name"].as_str().unwrap().starts_with("%private."));
            assert_eq!(demanded, !name.ends_with("/deferred.ts"), "{name}");
            assert!(
                ir["globals"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|global| { global["id"].as_str().unwrap().starts_with("%g.private.") })
            );
            for class in ir["classes"].as_array().unwrap() {
                for surface in ["methodNames", "methods"] {
                    assert!(
                        class[surface]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .all(|method| { !method.as_str().unwrap().starts_with('#') }),
                        "{name}: private method entered the public surface"
                    );
                }
            }
        }
        if name.starts_with("rust-native-symbol-methods/") {
            let descriptors = ir["classes"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|class| class["symbolMethods"].as_array().into_iter().flatten())
                .collect::<Vec<_>>();
            assert!(!descriptors.is_empty(), "{name}");
            if name.ends_with("/deferred.ts") {
                assert_eq!(descriptors.len(), 2);
                assert!(
                    descriptors
                        .iter()
                        .all(|descriptor| descriptor.get("function").is_none())
                );
                assert!(
                    !ir["functions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|function| function["name"].as_str().unwrap().contains(".%symbol."))
                );
            } else {
                assert!(
                    descriptors
                        .iter()
                        .any(|descriptor| descriptor["function"].is_string())
                );
            }
            assert!(ir["classes"].as_array().unwrap().iter().all(|class| {
                class["methodNames"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .all(|name| !name.as_str().unwrap().contains("%symbol"))
            }));
        }
        if name.starts_with("rust-native-process/architecture.") {
            assert!(ir.to_string().contains("process.arch"));
            let generated = fs::read_to_string(target.with_extension("rs")).unwrap();
            assert!(
                generated.contains("runtime::process_arch()"),
                "architecture must come from the output runtime, not the compiler host"
            );
        }
        assert_eq!(ir["functions"][0]["name"], ir["entry"]);
        if name.contains("functions") || name.contains("modules") {
            let functions = ir["functions"].as_array().unwrap();
            assert!(functions.len() > 1);
            assert!(functions.iter().skip(1).any(|f| {
                f["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["localId"].is_string() && p.get("id").is_none())
            }));
        }
        assert!(
            fs::read_to_string(target.with_extension("rs"))
                .unwrap()
                .contains("#![forbid(unsafe_code)]")
        );
    }
}

#[test]
fn callable_and_compiled_enum_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "boundary");
    for (name, source) in [
        (
            "escaped-function",
            "const f = (n: number) => n; const alias = f; const decorated = Object.assign(f, { value: 1 }); console.log(alias === decorated);",
        ),
        (
            "function-length",
            "const decorated = Object.assign((n: number) => n, { length: 2 });",
        ),
        (
            "function-bind",
            "const decorated = Object.assign((n: number) => n, { bind: (n: number) => n });",
        ),
        (
            "new-property-after-escape",
            "const decorated = Object.assign((n: number) => n, { value: 1 }); Object.assign(decorated, { extra: 2 });",
        ),
        (
            "erased-callable-properties",
            "const decorated = Object.assign((n: number) => n, { value: 1 }); const erased: unknown = decorated; console.log(erased === decorated);",
        ),
        (
            "forged-callable",
            "type F = ((n: number) => number) & { value: number }; const fake = { '\\0scriptc.call': (n: number) => n, value: 1 } as unknown as F; console.log(fake(1));",
        ),
        (
            "enum-extra-effect",
            "// @ts-nocheck\nvar Flags; (function (Flags) { Flags[Flags['NONE'] = 0] = 'NONE'; console.log('must not vanish'); })(Flags || (Flags = {}));",
        ),
        (
            "unbound-enum",
            "// @ts-nocheck\n(function (Flags) { Flags[Flags['NONE'] = 0] = 'NONE'; })(Flags || (Flags = {}));",
        ),
        (
            "enum-reassignment",
            "// @ts-nocheck\nvar Flags; (function (Flags) { Flags[Flags['NONE'] = 0] = 'NONE'; })(Flags || (Flags = {})); Flags = {};",
        ),
        (
            "enum-mutation",
            "// @ts-nocheck\nvar Flags; (function (Flags) { Flags[Flags['NONE'] = 0] = 'NONE'; })(Flags || (Flags = {})); Flags['NONE'] = 'wrong';",
        ),
        (
            "enum-dynamic-key",
            "// @ts-nocheck\nvar Flags; (function (Flags) { Flags[Flags['NONE'] = 0] = 'NONE'; })(Flags || (Flags = {})); function key(): string { return 'NONE'; } console.log(Flags[key()]);",
        ),
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{name}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve", "{name}");
        }
    }
}

#[test]
fn data_table_and_process_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.js");
    let target = binary(temp.path(), "data-boundary");
    for source in [
        "function effect() { console.log('effect'); return 1; } const table = { rows: ['GET', {a: 1}, {b: 2}], value: effect() }; var alias = table;",
        "const table = { rows: ['GET', {a: 1}, {b: 2}], get value() { console.log('getter'); return 1; } }; var alias = table;",
        "const other = { value: 1 }; const table = { rows: ['GET', {a: 1}, {b: 2}], ...other }; var alias = table;",
        "const table = { __proto__: null, rows: ['GET', {a: 1}, {b: 2}] }; var alias = table;",
        "const table = { rows: ['GET', {a: 1}, {b: 2}], value: 1, value: 2 }; var alias = table;",
        "let table = { rows: ['GET', {a: 1}, {b: 2}] }; var alias = table; table = { value: 1, value: 2 };",
        "const table = { rows: ['GET', {a: 1}, {b: 2}], sparse: [1, , 3] }; var alias = table;",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
    let input = temp.path().join("main.ts");
    for source in [
        "process.env.SCRIPTC_NATIVE_UNSUPPORTED_WRITE = 'x';",
        "// @ts-nocheck\nprocess.arch = 'arm64';",
        "const saved = process; console.log(saved.arch);",
        "const saved = process.env; console.log(saved.SCRIPTC_NATIVE_PROCESS_VALUE);",
        "const output = process.stdout; console.log(output.isTTY === true);",
    ] {
        fs::write(&input, source).unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--project")
            .arg(root().join("tests/corpus/rust-native-process/tsconfig.json"))
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn commonjs_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("tsconfig.json"), r#"{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","allowJs":true,"checkJs":false,"types":[],"lib":["ES2022","DOM"]}}"#).unwrap();
    fs::write(temp.path().join("package.json"), r#"{"type":"commonjs"}"#).unwrap();
    fs::write(temp.path().join("dep.js"), "exports.value = 1;").unwrap();
    let input = temp.path().join("entry.js");
    let target = binary(temp.path(), "cjs-boundary");
    for source in [
        "const request = './dep.js'; require(request);",
        "while (false) require('./dep.js');",
        "try { require('./dep.js'); } catch (error) {}",
        "false && require('./dep.js');",
        "var selected = true ? require('./dep.js') : require('./dep.js');",
        "if (false) { var path = require('path'); } console.log(path);",
        "function load() { return require('./dep.js'); } load();",
        "var path = require('path'); path = {};",
        "var path = require('path'); var path = console.log('must not drop');",
        "exports.__proto__ = {};",
        "exports.child = require('./data' + '.json');",
        "var exports; console.log(exports === module.exports);",
        "var module; console.log(module.exports);",
        "if (console.log('effect')) console.log('truthy');",
    ] {
        fs::write(&input, source).unwrap();
        fs::write(temp.path().join("data.json"), "{}").unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
    fs::write(temp.path().join("package.json"), r#"{"type":"module"}"#).unwrap();
    fs::write(temp.path().join("dep.cjs"), "exports.value = 1;").unwrap();
    for source in [
        "import * as namespace from './dep.cjs'; console.log(namespace.value);",
        "export { value } from './dep.cjs';",
        "const dependency = require('./dep.cjs');",
    ] {
        fs::write(&input, source).unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn json_require_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("package.json"), r#"{"type":"commonjs"}"#).unwrap();
    fs::write(temp.path().join("tsconfig.json"), r#"{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","allowJs":true,"checkJs":false,"resolveJsonModule":true,"types":[],"lib":["ES2022","DOM"]}}"#).unwrap();
    let input = temp.path().join("entry.cjs");
    let data = temp.path().join("data.json");
    let target = binary(temp.path(), "json-boundary");
    fs::write(
        &input,
        "const data = require('./data.json'); console.log(data);",
    )
    .unwrap();
    for bytes in [
        r#"{"value":1,}"#,
        "/* comment */ {}",
        r#""\uD800""#,
        r#"{"value":"\uDFFF"}"#,
    ] {
        fs::write(&data, bytes).unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{bytes}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
    fs::write(&data, r#"{"value":1}"#).unwrap();
    fs::write(
        temp.path().join("bridge.cjs"),
        "const data = require('./data.json'); exports.data = data;",
    )
    .unwrap();
    fs::write(temp.path().join("package.json"), r#"{"type":"module"}"#).unwrap();
    let input = temp.path().join("mixed.js");
    fs::write(&input, "import data from './data.json' with { type: 'json' }; import bridge from './bridge.cjs'; console.log(data === bridge.data);").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .arg("--no-engine")
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        !result.status.success()
            && stderr.contains("SCN1001")
            && stderr.contains("shared materialization"),
        "{stderr}"
    );
    for path in [
        &target,
        &target.with_extension("ir.json"),
        &target.with_extension("rs"),
    ] {
        assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
    }
}

#[test]
fn set_and_tuple_rest_boundaries_preserve_previous_native_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "set-boundary");
    for source in [
        "const set = new Set([{id: 1}]); set.values();",
        "const seed = new Set<string>(); const set = new Set(seed);",
        "const set = new Set<string>(); set.values();",
        "const set = new Set<string>(); const value: unknown = set;",
        "const set = new Set<string>(); const value: unknown = {set};",
        "const set = new Set<string>(); const value: unknown = [set];",
        "function read(value: Set<string> | string): number { return 1; } console.log(read('x'));",
        "function read(set: Set<string>): boolean { return set.has('x'); } const value: unknown = read;",
    ] {
        fs::write(&input, source).unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
    fs::write(
        temp.path().join("library.d.ts"),
        "export declare const variable: (...args: string[]) => string;",
    )
    .unwrap();
    fs::write(
        temp.path().join("library.js"),
        "export const variable = function (value) { return value; };",
    )
    .unwrap();
    fs::write(
        &input,
        "import { variable } from './library.js'; console.log(variable('x')); ",
    )
    .unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        !result.status.success() && String::from_utf8_lossy(&result.stderr).contains("SCN1001"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "preserve");
}

#[test]
fn template_boundaries_preserve_previous_native_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "strings");
    for source in [
        "console.log(`${{ value: 1 }}`);",
        "const value = { toString: () => 'effect' }; console.log(`${value}`);",
        "console.log([{ value: 1 }].join(','));",
        "function tag(parts: TemplateStringsArray): string { return 'tag'; } console.log(tag`x`);",
        "const values = ['x']; console.log(values.join(...values));",
        "console.log([1, , 3].join(','));",
    ] {
        fs::write(&input, source).unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
    fs::write(&input, format!("import {{ ResponseError }} from {:?}; new ResponseError<{{answer: number}}>({{url: '/'}}, {{data: 'wrong', errors: []}});", root().join("tests/corpus/rust-native-generic-errors/library.js").to_string_lossy().replace('\\', "/"))).unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("TS2322"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "preserve");
}

#[test]
fn json_function_boundaries_preserve_previous_native_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "json-boundary");
    for source in [
        "const save = JSON; save.stringify(1);",
        "JSON.stringify = (value: any): string => 'changed'; JSON.stringify(1);",
        "const read = JSON.parse; read('{}', (key: string, value: any) => value);",
    ] {
        fs::write(&input, source).unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn receiver_boundaries_preserve_previous_native_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let target = binary(temp.path(), "receiver-boundary");
    fs::write(temp.path().join("ns.mjs"), "// @ts-nocheck\nexport function declaration() { return this; } export const expression = function() { return this; };").unwrap();
    for (name, source, reason) in [
        (
            "sloppy.cjs",
            "const f = function() { return this; }; f.call(null);",
            "sloppy function this",
        ),
        (
            "top.cjs",
            "const f = () => this === undefined; f();",
            "top-level arrow this",
        ),
        (
            "async.mts",
            "async function f(this: any): Promise<any> { return this; } f.call({});",
            "async function this",
        ),
        (
            "set.mts",
            "const object = {set: new Set([1]), method: function(this: any): any { return this; }}; object.method();",
            "erasing Set",
        ),
        (
            "set.mts",
            "const object = {set: new Set([1]), method(this: unknown): unknown { return this; }}; object.method();",
            "erasing Set",
        ),
        (
            "escaped.cjs",
            "'use\\x20strict'; const f = function() { return this; }; f.call(null);",
            "sloppy function this",
        ),
        (
            "namespace-declaration.mts",
            "import * as ns from './ns.mjs'; ns.declaration();",
            "namespace method this",
        ),
        (
            "namespace-expression.mts",
            "import * as ns from './ns.mjs'; ns.expression();",
            "namespace method this",
        ),
        (
            "namespace-alias.mts",
            "import * as ns from './ns.mjs'; const alias = ns; alias.expression();",
            "namespace method this",
        ),
        (
            "namespace-parenthesized.mts",
            "import * as ns from './ns.mjs'; const alias = ns; (alias.expression)();",
            "namespace method this",
        ),
        (
            "getter.mts",
            "const callback = function(this: any): any { return this; }; class Holder { get callback() { return callback; } } new Holder().callback();",
            "getter-returned callable this",
        ),
        (
            "getter-parenthesized.mts",
            "const callback = function(this: any): any { return this; }; class Holder { get callback() { return callback; } } (new Holder().callback)();",
            "getter-returned callable this",
        ),
        (
            "directive-suffix.cjs",
            r#""prefix\"use strict"; const f = function() { return this; }; f.call(null);"#,
            "sloppy function this",
        ),
    ] {
        let input = temp.path().join(name);
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && stderr.contains(reason)
                && !stderr.contains("panicked"),
            "{name}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn logical_boundaries_preserve_previous_native_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "logical-boundary");
    for source in [
        "const value: any = 1; value && eval('1');",
        "const values = new Set([1]); values || 0;",
    ] {
        fs::write(&input, source).unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn promise_boundaries_preserve_previous_native_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "promise");
    for source in [
        "Promise.all([]);",
        "Promise.resolve().catch(() => {});",
        "Promise.resolve(1).then(() => 1, async () => await Promise.resolve(2));",
        "new Promise<void>((resolve) => resolve());",
        "const value = { then: (resolve: (n: number) => unknown) => { resolve(1); } }; Promise.resolve(value);",
        "type A = { kind: 'a'; value: string } | { kind: 'b' }; const value: A = { kind: 'c' } as any;",
    ] {
        fs::write(&input, source).unwrap();
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn regex_and_var_boundaries_refuse_without_replacing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "boundary");
    for (name, source) in [
        ("regex-exec", "const pattern = /x/; pattern.exec('x');"),
        ("regex-flags", "const pattern = /x/d;"),
        ("regex-copy", "const pattern = new RegExp(/x/);"),
        ("var-map", "var map = new Map<string, number>();"),
        ("var-destructure", "var [value] = [1]; console.log(value);"),
        (
            "var-return-contract",
            "read(); var value = 1; function read(): number { return value; }",
        ),
        (
            "var-call-write",
            "var value: number | undefined = 1; function clear(): void { value = undefined; } if (value !== undefined) { clear(); console.log(value as number); }",
        ),
        (
            "var-map-write",
            "var value: number | undefined = 1; if (value !== undefined) { const mapped = [1].map(item => { value = undefined; return item; }); console.log(value as number); }",
        ),
        (
            "var-null-call-write",
            "function run(value: number | null): void { var value: number | null; const clear = (): void => { value = null; }; if (value !== null) { clear(); console.log(value as number); } } run(1);",
        ),
    ] {
        fs::write(&input, source).unwrap();
        fs::write(&target, "preserve").unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001"),
            "{name}: {stderr}"
        );
        assert!(
            !stderr.contains("panicked") && !stderr.contains("SCN9001"),
            "{name}: {stderr}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"preserve", "{name}");
        assert!(!target.with_extension("ir.json").exists());
    }
}

#[test]
fn error_definitions_defer_instance_code_and_refuse_unported_effects() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "errors");
    fs::write(&input, "class Unused extends Error { context: unknown; constructor(value: unknown) { super(); this.context = value; while (false) {} } } console.log('defined');").unwrap();
    let output = temp.path().join("unused.json");
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(&output)
        .output()
        .unwrap();
    success(&result);
    let ir: serde_json::Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    assert_eq!(ir["functions"].as_array().unwrap().len(), 1);
    assert!(
        ir["classes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["runtime"] == true)
    );
    assert!(
        ir["globals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["name"] == "Unused")
    );
    for (name, source) in [
        (
            "static-field",
            "class Fault extends Error { static effect = console.log('must not vanish'); }",
        ),
        (
            "static-block",
            "class Fault extends Error { static { console.log('must not vanish'); } }",
        ),
        (
            "computed-field",
            "class Fault extends Error { ['field'] = 1; }",
        ),
        (
            "heritage-effect",
            "function base(): typeof Error { console.log('base'); return Error; } class Fault extends base() {}",
        ),
        (
            "method",
            "class Fault extends Error { async method(): Promise<number> { return await Promise.resolve(1); } } new Fault().method();",
        ),
        (
            "accessor",
            "class Fault extends Error { get #field(): number { return 1; } }",
        ),
        ("generic", "class Fault<T> extends Error {}"),
        ("cause", "new Error('message', { cause: 1 });"),
        (
            "function-field",
            "class Fault extends Error { context: () => number; constructor(value: () => number) { super(); this.context = value; } } const fault = new Fault(() => 1);",
        ),
        (
            "constructor-body",
            "class Fault extends Error { constructor() { super(); while (false) {} } } new Fault();",
        ),
        (
            "constructor-return",
            "class Fault extends Error { constructor(message: string) { super(message); if (message === '') return; } } new Fault('');",
        ),
        (
            "parameter-property",
            "class Fault extends Error { constructor(public code: number) { super(); } } new Fault(1);",
        ),
        (
            "local-class-expression",
            "function make() { return class extends Error {}; } const Constructor = make(); new Constructor();",
        ),
        (
            "class-expression-effects",
            "const Constructor = class extends Error { static value = console.log('must not vanish'); };",
        ),
        (
            "constructor-identity-widening",
            "class Base extends Error {} class Derived extends Base {} const Constructor: typeof Base = Derived; new Constructor();",
        ),
        (
            "possibly-undefined-constructor",
            "class Fault extends Error {} var Constructor: typeof Fault | undefined; function make(): void { new Constructor!(); } make();",
        ),
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let failed = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(!failed.status.success(), "{name}");
        let stderr = String::from_utf8_lossy(&failed.stderr);
        assert!(stderr.contains("SCN1001"), "{name}: {stderr}");
        assert!(!stderr.contains("panicked"), "{name}: {stderr}");
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read(artifact).unwrap(), b"preserve", "{name}");
        }
    }
}

#[test]
fn function_demand_keeps_type_checks_effects_and_escaping_values() {
    let temp = tempfile::tempdir().unwrap();
    for (name, source, expected) in [
        (
            "unused-type-error",
            "function unused(): number { const bad: number = 'wrong'; return bad; } console.log(1);",
            "TS2322",
        ),
        (
            "reachable-chain",
            "async function unsupported(): Promise<number> { return await Promise.resolve(1); } function root(): void { unsupported(); } root();",
            "call 'unsupported'",
        ),
        (
            "escaping-value",
            "async function unsupported(): Promise<number> { return await Promise.resolve(1); } const alias = unsupported;",
            "function value 'unsupported'",
        ),
        (
            "unused-initializer",
            "function effect(): number { while (true) { return 1; } } const unused = effect();",
            "call 'effect'",
        ),
        (
            "callback-escape",
            "function consume(callback: () => void): void {} function unsupported(): void { while (true) {} } consume(unsupported);",
            "function value 'unsupported'",
        ),
    ] {
        let input = temp.path().join(format!("{name}.ts"));
        fs::write(&input, source).unwrap();
        let target = temp.path().join(format!("{name}.ir.json"));
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{name}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains(expected), "{name}: {stderr}");
        if name != "unused-type-error" {
            assert!(
                stderr.contains("native reachability: entry initialization"),
                "{stderr}"
            );
        }
        assert!(!target.exists(), "{name} published invalid IR");
    }
    let input = root().join("tests/corpus/rust-native-reachability/main.ts");
    let mut outputs = Vec::new();
    for index in 0..2 {
        let target = temp.path().join(format!("stable-{index}.ir.json"));
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        success(&result);
        outputs.push(fs::read(target).unwrap());
    }
    assert_eq!(
        outputs[0], outputs[1],
        "native planning must be deterministic"
    );
    let ir: serde_json::Value = serde_json::from_slice(&outputs[0]).unwrap();
    assert_eq!(
        ir["functions"].as_array().unwrap().len(),
        5,
        "only entry, initializer and reachable functions belong in IR"
    );
}

#[test]
fn diagnostics_refuse_invalid_and_unported_sources_without_publishing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    for (name, source, code) in [
        (
            "type",
            "const bad: number = 'wrong'; console.log(bad);",
            "TS2322",
        ),
        ("syntax", "const broken: = 1;", "TS1110"),
        (
            "capture",
            "function outer(): number { const value = 1; function f(): number { return value; } return f(); } console.log(outer());",
            "SCN1001",
        ),
        ("loop", "while (true) {}", "SCN1001"),
        (
            "map-this-arg",
            "const values = [1].map(value => value, {});",
            "SCN1001",
        ),
        (
            "map-rest-tuple",
            "function f(pair: [string, ...number[]]): void {} f;",
            "SCN1001",
        ),
        (
            "map-optional-tuple",
            "function f(pair: [string, number?]): void {} f;",
            "SCN1001",
        ),
        (
            "map-sparse-input",
            "const values: number[] = [1, , 2];",
            "TS2322",
        ),
        ("map-callable", "const values = [1].map(1);", "TS2345"),
        (
            "map-pair-key",
            "const map = new Map<string, number>([1].map(value => [value, value]));",
            "TS2769",
        ),
        (
            "map-other-iterable",
            "const map = new Map(new Map<string, number>());",
            "SCN1001",
        ),
        ("format", "console.log('%s', 42);", "SCN1001"),
        ("surrogate", "console.log('\\uD800');", "SCN1001"),
        ("bigint", "console.log(1n);", "SCN1001"),
        ("void-argument", "console.log(console.log(1));", "SCN1001"),
        (
            "block-function",
            "{ function f() { return 1; } console.log(f()); }",
            "SCN1001",
        ),
        (
            "function-forward-capture",
            "function outer(): number { const g = () => f(); const f = () => 1; return g(); } console.log(outer());",
            "SCN1001",
        ),
        (
            "default-unit-param",
            "function f(n: undefined = undefined) { return 1; } console.log(f());",
            "SCN1001",
        ),
        (
            "optional-call",
            "function f(n?: () => number) { return n?.(); } console.log(f());",
            "SCN1001",
        ),
        (
            "variadic-tuple-param",
            "function f(...n: [number, ...number[]]) { return 1; } console.log(f(1));",
            "SCN1001",
        ),
        (
            "required-after-default",
            "function f(a = 1, b: number) { return a + b; } console.log(f());",
            "TS2554",
        ),
        (
            "self-default",
            "function f(a: number = a) { return a; } console.log(f());",
            "TS2372",
        ),
        (
            "async",
            "async function f() { return await Promise.resolve(1); } f();",
            "SCN1001",
        ),
        (
            "readonly-map-write",
            "function f(map: ReadonlyMap<string, number>): void { map.set('x', 1); }",
            "TS2339",
        ),
        (
            "map-key-type",
            "const map = new Map<boolean, number>();",
            "SCN1001",
        ),
        (
            "dictionary-function-cycle",
            "const values: Record<string, () => number> = {}; values.x = () => 1;",
            "SCN1001",
        ),
        (
            "dictionary-prototype-write",
            "const values: Record<string, boolean> = {}; values['__proto__'] = false;",
            "SCN1001",
        ),
        (
            "mixed-index-record",
            "function f(record: { fixed: string; [key: string]: string }): void {} f;",
            "SCN1001",
        ),
        (
            "record-accessor",
            "const record = { get value(): number { return 1; } }; console.log(record.value);",
            "SCN1001",
        ),
        (
            "record-generator-method",
            "const record = { *value(): Generator<number> { yield 1; } }; console.log(record.value());",
            "SCN1001",
        ),
        (
            "record-prototype",
            "const record = { __proto__: { value: 1 } };",
            "SCN1001",
        ),
        ("unit-storage", "const empty: null = null;", "SCN1001"),
        ("unit-expression", "null;", "SCN1001"),
        (
            "unit-return",
            "function f(): null { return null; } f();",
            "SCN1001",
        ),
        (
            "record-width-variance",
            "function f(record: { n: number | undefined }): number { return 1; } const record = { n: 1, extra: 2 }; console.log(f(record));",
            "SCN1001",
        ),
        (
            "readonly-record",
            "const record: { readonly n: number } = { n: 1 }; record.n = 2;",
            "TS2540",
        ),
        (
            "optional-record-type",
            "function f(record: { n?: number }): void {} f({ n: 'bad' });",
            "TS2322",
        ),
        (
            "generic-rest",
            "function f<T>(...n: T[]) { return n[0]; } console.log(f(1));",
            "SCN1001",
        ),
        (
            "nested-function",
            "function f() { function inner() { return 1; } return inner(); } console.log(f());",
            "SCN1001",
        ),
    ] {
        let input = temp.path().join(format!("{name}.ts"));
        fs::write(&input, source).unwrap();
        let target = binary(temp.path(), name);
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{name}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains(code), "{name}: {stderr}");
        assert!(!target.exists());
        assert!(!target.with_extension("rs").exists());
        assert!(!target.with_extension("ir.json").exists());
    }
}

#[test]
fn dependency_diagnostics_publish_no_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let dependency = temp.path().join("dependency.ts");
    for (source, other, code) in [
        (
            "import { value } from './dependency.ts'; console.log(value);",
            "export const value: number = 'invalid';",
            "TS2322",
        ),
        (
            "import * as ns from './dependency.ts'; console.log((console.log('receiver effect'), ns).f(1));",
            "export function f(n: number): number { return n; }",
            "SCN1001",
        ),
    ] {
        fs::write(&input, source).unwrap();
        fs::write(&dependency, other).unwrap();
        let target = binary(temp.path(), "bad-module");
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(
            String::from_utf8_lossy(&result.stderr).contains(code),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert!(!artifact.exists());
        }
    }
}

#[test]
fn module_slots_check_tdz_on_reads_writes_defaults_and_cycles() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let dependency = temp.path().join("dependency.ts");
    let package = temp.path().join("node_modules/tdz-contract");
    fs::create_dir_all(&package).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"name":"tdz-contract","type":"module","main":"index.js","types":"index.d.ts"}"#,
    )
    .unwrap();
    fs::write(package.join("index.d.ts"), "export let value: number;").unwrap();
    fs::write(package.join("index.js"), "value = 2; export let value = 3;").unwrap();
    for (index, source, other, binding) in [
        (
            0,
            "console.log('before'); read(); let count = 1; function read(): void { console.log(count); }",
            "",
            "count",
        ),
        (
            1,
            "console.log('before'); write(); let count = 1; function write(): void { count = 2; }",
            "",
            "count",
        ),
        (
            2,
            "console.log('before'); read(); let count = 1; function read(value = count): void { console.log(value); }",
            "",
            "count",
        ),
        (
            3,
            "import { other } from './dependency.ts'; export const value: number = other; console.log(value);",
            "import { value } from './main.ts'; export const other: number = value;",
            "value",
        ),
        (
            4,
            "import { value } from 'tdz-contract'; console.log(value);",
            "",
            "value",
        ),
        (
            5,
            "console.log('before'); make(); class Fault extends Error {} function arg(): string { console.log('argument'); return 'late'; } function make(): void { new Fault(arg()); }",
            "",
            "Fault",
        ),
        (
            6,
            "console.log('before'); inspect(new Error()); class Fault extends Error {} function inspect(value: Error): void { console.log(value instanceof Fault); }",
            "",
            "Fault",
        ),
        (
            7,
            "import './dependency.ts'; export class Fault extends Error {}",
            "import { Fault } from './main.ts'; console.log('before'); export class Child extends Fault {}",
            "Fault",
        ),
        (
            8,
            "console.log('before'); capture(); class Fault extends Error {} function capture(): void { const Alias = Fault; console.log(Alias === Fault); }",
            "",
            "Fault",
        ),
        (
            9,
            "class Fault extends Error {} console.log('before'); make(); const Alias = Fault; function arg(): string { console.log('argument'); return 'late'; } function make(): void { new Alias(arg()); }",
            "",
            "Alias",
        ),
        (
            10,
            "console.log('before'); make(); class Box { value = 1; } function make(): void { new Box(); }",
            "",
            "Box",
        ),
        (
            11,
            "console.log('before'); inspect({}); class Box {} function inspect(value: unknown): void { console.log(value instanceof Box); }",
            "",
            "Box",
        ),
    ] {
        fs::write(&input, source).unwrap();
        fs::write(&dependency, other).unwrap();
        let target = binary(temp.path(), &format!("tdz-{index}"));
        let build = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        success(&build);
        let expected = Command::new(oracle()).arg(&input).output().unwrap();
        let actual = Command::new(&target)
            .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
            .output()
            .unwrap();
        assert_eq!(actual.status.code(), expected.status.code(), "case {index}");
        assert_eq!(actual.stdout, expected.stdout, "case {index}");
        let message = format!("ReferenceError: Cannot access '{binding}' before initialization");
        assert!(
            String::from_utf8_lossy(&expected.stderr).contains(&message),
            "{}",
            String::from_utf8_lossy(&expected.stderr)
        );
        assert!(
            String::from_utf8_lossy(&actual.stderr).contains(&message),
            "{}",
            String::from_utf8_lossy(&actual.stderr)
        );
        assert!(!String::from_utf8_lossy(&actual.stderr).contains("heap audit"));
    }
}

#[test]
fn emit_modes_and_paths_with_spaces_preserve_sources_and_failed_outputs() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("aÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o entry.ts");
    fs::write(&input, "console.log('ok', 42);").unwrap();
    for (kind, extension) in [("ir", "json"), ("rust", "rs")] {
        let target = temp.path().join(format!("result.{extension}"));
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--emit", kind, "--out"])
            .arg(&target)
            .output()
            .unwrap();
        success(&result);
        assert!(target.is_file());
    }
    let original = fs::read(&input).unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(&input)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(fs::read(&input).unwrap(), original);
    let target = binary(temp.path(), "old");
    fs::write(&target, "previous artifact").unwrap();
    fs::write(&input, "while (true) {}").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(fs::read_to_string(target).unwrap(), "previous artifact");
}

#[test]
fn project_config_preserves_ambient_roots_and_excludes_unrelated_sources() {
    let temp = tempfile::tempdir().unwrap();
    let src = temp.path().join("src");
    fs::create_dir(&src).unwrap();
    fs::write(temp.path().join("base.json"), "{ // JSONC base\n \"compilerOptions\": { \"strict\": true, \"target\": \"ES2022\", \"lib\": [\"ES2022\"], \"types\": [], }, }").unwrap();
    let config = temp.path().join("tsconfig.json");
    let config_source = "{\"extends\":\"./base.json\",\"include\":[\"src/**/*.ts\"]}";
    fs::write(&config, config_source).unwrap();
    fs::write(
        src.join("globals.d.ts"),
        "type Score = number; declare const console: { log(value: number): void }; ",
    )
    .unwrap();
    fs::write(
        src.join("unrelated.ts"),
        "const broken: number = 'unrelated';",
    )
    .unwrap();
    let input = src.join("main.ts");
    fs::write(&input, "const score: Score = 42; console.log(score);").unwrap();
    let target = temp.path().join("project.ir.json");
    let output = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&output);
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        fs::canonicalize(metadata["project"].as_str().unwrap()).unwrap(),
        fs::canonicalize(&config).unwrap()
    );
    assert_eq!(fs::read_to_string(&config).unwrap(), config_source);
    assert!(!src.join("main.js").exists());
    fs::write(&input, "function f(value) { return 1; } console.log(f(2));").unwrap();
    let failed = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(temp.path().join("failed.json"))
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("TS7006"));
}

#[test]
fn explicit_project_is_used_and_broken_configs_do_not_fall_back() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    fs::write(&input, "console.log(42);").unwrap();
    fs::write(
        temp.path().join("tsconfig.json"),
        "{\"extends\":\"./missing.json\"}",
    )
    .unwrap();
    let explicit = temp.path().join("selected.json");
    fs::write(&explicit, "{\"compilerOptions\":{\"strict\":true,\"lib\":[\"ES2022\",\"DOM\"],\"types\":[]},\"files\":[\"main.ts\"]}").unwrap();
    let target = temp.path().join("selected.ir.json");
    let output = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .arg("--project")
        .arg(&explicit)
        .args(["--emit", "ir", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&output);
    let failed = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(temp.path().join("failed.json"))
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("missing.json"));
    assert!(!temp.path().join("failed.json").exists());
}

#[test]
fn package_declarations_are_checked_before_runtime_implementation_lowering() {
    let temp = tempfile::tempdir().unwrap();
    for (entry, code, detail) in [
        ("type-error.ts", "TS2345", "not assignable"),
        ("unported-api.ts", "SCN1001", "fs/promises.readFile"),
    ] {
        let input = root()
            .join("tests/corpus/rust-native-package/negative")
            .join(entry);
        let target = binary(temp.path(), entry);
        let result = Command::new(compiler())
            .arg("build")
            .arg(input)
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success());
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains(code) && stderr.contains(detail), "{stderr}");
        assert!(!target.exists());
        assert!(!target.with_extension("ir.json").exists());
    }
}

#[test]
fn concurrent_native_builds_share_dependencies_without_binary_collisions() {
    let temp = tempfile::tempdir().unwrap();
    let project = root().join("tests/corpus/rust-native-builtins/tsconfig.json");
    let mut children = Vec::new();
    for name in ["first", "second"] {
        let input = temp.path().join(format!("{name}.ts"));
        fs::write(&input, format!("import {{ dirname }} from 'node:path/posix'; console.log(dirname('/{name}/file')); ")).unwrap();
        let output = binary(temp.path(), name);
        let child = Command::new(compiler())
            .arg("build")
            .arg(input)
            .arg("--project")
            .arg(&project)
            .arg("--out")
            .arg(&output)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        children.push((name, output, child));
    }
    for (name, target, child) in children {
        success(&child.wait_with_output().unwrap());
        let actual = Command::new(target)
            .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
            .output()
            .unwrap();
        success(&actual);
        assert_eq!(actual.stdout, format!("/{name}\n").as_bytes());
        assert!(actual.stderr.is_empty());
    }
}

#[test]
fn json_aggregate_mutations_are_refused_without_publishing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("package.json"), "{\"type\":\"module\"}").unwrap();
    fs::write(temp.path().join("data.json"), "{\"version\":\"1.0.0\"}").unwrap();
    let input = temp.path().join("main.ts");
    fs::write(&input, "import data from './data.json' with { type: 'json' }; data.version = 'changed'; console.log(data.version);").unwrap();
    let target = binary(temp.path(), "mutated-json");
    let result = Command::new(compiler())
        .arg("build")
        .arg(input)
        .arg("--project")
        .arg(root().join("tests/corpus/rust-native-json/tsconfig.json"))
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("SCN1001"));
    assert!(!target.exists());
    assert!(!target.with_extension("ir.json").exists());
}

#[test]
fn declaration_contracts_validate_js_bodies_and_refuse_ambiguous_abis() {
    for (name, declarations, implementation, call, code) in [
        (
            "return-type",
            "export declare function value(n: number): number;",
            "export function value(n) { return 'wrong'; }",
            "value(2)",
            "SCN1001",
        ),
        (
            "callback-argument",
            "export declare function value(cb: (n: number) => number): number;",
            "export function value(cb) { return cb('wrong'); }",
            "value(n => n + 1)",
            "SCN1001",
        ),
        (
            "public-any-unsupported-body",
            "export declare function value(n: any): number;",
            "export function value(n) { while (n) {} return 1; }",
            "value(2)",
            "SCN1001",
        ),
        (
            "consumer-type",
            "export declare function value(n: number): number;",
            "export function value(n) { return n; }",
            "value('wrong')",
            "TS2345",
        ),
        (
            "overloaded-arity",
            "export declare function value(n: number): number; export declare function value(n: number, extra: number): number;",
            "export function value(n) { return n; }",
            "value(2, 3)",
            "SCN1001",
        ),
        (
            "conflicting",
            "export declare function value(n: number): number; export declare function other(n: string): string;",
            "function shared(n) { return n; } export { shared as value, shared as other };",
            "value(2)",
            "SCN1001",
        ),
        (
            "arity",
            "export declare function value(n: number, extra: number): number;",
            "export function value(n) { return n; }",
            "value(2, 3)",
            "SCN1001",
        ),
        (
            "monomorphic-local",
            "export declare function value(n: number): number;",
            "export function value(n) { let local = n; local = 'changed'; return 1; }",
            "value(2)",
            "SCN1001",
        ),
        (
            "record-body",
            "export declare function value(n: number): { count: number };",
            "export function value(n) { return { count: 'wrong' }; }",
            "value(2).count",
            "SCN1001",
        ),
        (
            "map-value-contract",
            "export declare function value(n: number): ReadonlyMap<string, number>;",
            "export function value(n) { return new Map([['answer', 'wrong']]); }",
            "value(2).has('answer')",
            "SCN1001",
        ),
        (
            "map-key-contract",
            "export declare function value(n: number): ReadonlyMap<string, number>;",
            "export function value(n) { return new Map([[7, n]]); }",
            "value(2).has('answer')",
            "SCN1001",
        ),
        (
            "array-default-contract",
            "export declare function value(n?: number[]): number;",
            "export function value(n = ['wrong']) { return n.length; }",
            "value()",
            "SCN1001",
        ),
        (
            "dictionary-array-contract",
            "export declare function value(n: number): Record<string, string[] | undefined>;",
            "export function value(n) { return { agents: [n] }; }",
            "value(2)",
            "SCN1001",
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{\"type\":\"module\"}").unwrap();
        let package = temp.path().join("node_modules/contract");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("package.json"), "{\"name\":\"contract\",\"type\":\"module\",\"exports\":{\".\":{\"types\":\"./public.d.mts\",\"default\":\"./implementation.mjs\"}}}").unwrap();
        fs::write(package.join("public.d.mts"), declarations).unwrap();
        fs::write(package.join("implementation.mjs"), implementation).unwrap();
        let input = temp.path().join("main.ts");
        fs::write(
            &input,
            format!("import {{ value }} from 'contract'; console.log({call});"),
        )
        .unwrap();
        let target = binary(temp.path(), name);
        let result = Command::new(compiler())
            .arg("build")
            .arg(input)
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{name}");
        assert!(
            String::from_utf8_lossy(&result.stderr).contains(code),
            "{name}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert!(!artifact.exists(), "{name}: {}", artifact.display());
        }
    }
}

#[test]
fn inspection_includes_uncalled_bodies_and_keeps_outputs_atomic() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("tsconfig.json"), r#"{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","strict":true,"types":["node"],"skipLibCheck":true}}"#).unwrap();
    let project = root().join("tests/corpus/rust-native-process/tsconfig.json");
    let input = temp.path().join("inspect.ts");
    fs::write(temp.path().join("host.d.ts"), "declare const HostRuntime: { open(): void; run(template: TemplateStringsArray): string }; ").unwrap();
    fs::write(&input, "/// <reference path='./host.d.ts' />\nimport { readFileSync as read, existsSync } from 'node:fs'; async function unused() { for (const file of ['x']) { try { await Promise.resolve(read(file, 'utf8')); } catch {} } } console.log(existsSync('.')); class Surface { async method() {} *empty() {} get value() { return 1; } } const token = Symbol('inventory'); const sink = console.log; Object.keys({}); const codec = new TextEncoder(); Math.max(1, 2); function unusedHost() { HostRuntime.open(); return HostRuntime.run`echo`; } function shadow(Object: {keys(value: {}): string[]}) { return Object.keys({}); } ").unwrap();
    let target = temp.path().join("inventory.json");
    // Explicit project gives the same bundled declarations as the build command.
    let result = Command::new(compiler())
        .arg("inspect")
        .arg(&input)
        .arg("--project")
        .arg(&project)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    success(&result);
    let report: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(report["schemaVersion"], 1);
    assert_eq!(report["engine"], "none");
    assert_eq!(
        report["requirements"]["async-functions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(report["requirements"]["await"].as_array().unwrap().len(), 1);
    assert_eq!(
        report["requirements"]["exception-handlers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        report["builtinCalls"]["fs.readFileSync"]["signatureAvailable"],
        false
    );
    assert_eq!(
        report["builtinCalls"]["fs.existsSync"]["signatureAvailable"],
        true
    );
    for feature in ["generator-functions", "accessors", "tagged-templates"] {
        assert_eq!(report["requirements"][feature].as_array().unwrap().len(), 1);
    }
    assert_eq!(report["globalCalls"]["Symbol"].as_array().unwrap().len(), 1);
    assert_eq!(
        report["globalCalls"]["new TextEncoder"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        report["globalCalls"]["Math.max"].as_array().unwrap().len(),
        1
    );
    assert!(report["globalValues"].get("max").is_none());
    assert_eq!(
        report["globalCalls"]["HostRuntime.open"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        report["globalValues"]["HostRuntime.run"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        report["globalCalls"]["Object.keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        report["globalValues"]["console.log"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(!target.with_extension("rs").exists());
    let original = fs::read(&target).unwrap();
    fs::write(&input, "const invalid: number = 'wrong';").unwrap();
    let result = Command::new(compiler())
        .arg("inspect")
        .arg(&input)
        .arg("--project")
        .arg(&project)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("TS2322"));
    assert_eq!(fs::read(target).unwrap(), original);
}

#[test]
fn exception_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "exception-boundary");
    for source in [
        "try { throw {}; } catch ({ message }) { console.log(message); }",
        "try { throw 1; } catch (error) { error = 2; console.log(error); }",
        "try { throw 1; } catch (error) { const replace = () => { error = 2; }; replace(); }",
        "class Ordinary { get #value() { return 1; } } try { throw new Ordinary(); } catch {}",
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success());
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            stderr.contains("SCN1001") || stderr.contains("TS2339"),
            "{stderr}"
        );
        assert!(!stderr.contains("panicked"), "{stderr}");
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn ordinary_class_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "class-boundary");
    for source in [
        "class Box { static value = console.log('effect'); } new Box();",
        "class Box { method() { return 1; } } const unbound = new Box().method; unbound();",
        "class Box { get #value() { return 1; } } new Box();",
        "class Box { ['value'] = 1; } new Box();",
        "class Box { constructor(public value: number) {} } new Box(1);",
        "class Box { constructor() { return {}; } } new Box();",
        "class Box { '__proto__' = 1; } new Box();",
        "class Box { constructor() { if (false) return; } } new Box();",
        "class Base {} class Child extends Base { constructor() { if (true) super(); } } new Child();",
        "class Box { *method(): Generator<number> { yield 1; } } new Box().method();",
        "class Box { async method(): Promise<number> { return await Promise.resolve(1); } } new Box().method();",
        "class Base { method(value: number): number { return value; } } class Child extends Base { method(value: number | undefined): number { return 1; } } const value: Base = new Child(); value.method(1);",
        "class Fault extends Error { toString(): string { return 'custom'; } } new Fault();",
    ] {
        fs::write(&input, source).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ];
        for artifact in artifacts {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{source}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains("SCN1001"), "{source}: {stderr}");
        assert!(!stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn private_method_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "private-method-boundary");
    for source in [
        "class Box { static #method() {} } new Box();",
        "class Box { get #method() { return 1; } } new Box();",
        "class Box { #method() { return 1; } read() { return this.#method; } } new Box().read();",
        "class Box { #method() { return 1; } write() { this.#method = () => 2; } } new Box().write();",
        "class Box { *#method() { yield 1; } read() { return this.#method(); } } new Box().read();",
        "class Box { async *#method() { yield 1; } read() { return this.#method(); } } new Box().read();",
        "class Box { #method<T>(value: T): T { return value; } read() { return this.#method(1); } } new Box().read();",
        "class Box { #method() {} has(value: unknown) { return #method in value; } } new Box().has({});",
        "function factory() { return class Box { #method() {} }; } new (factory())();",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{source}");
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(error.contains("SCN1001"), "{source}: {error}");
        assert!(!error.contains("panicked"), "{error}");
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn private_field_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "private-boundary");
    for source in [
        "class Box { static #value = 1; } new Box();",
        "class Box { get #value() { return 1; } } new Box();",
        "class Box { set #value(value: number) {} } new Box();",
        "class Box { #value = 1; update() { this.#value += 1; } } new Box().update();",
        "class Box { #value = 1; update() { return this.#value++; } } new Box().update();",
        "class Box { #value = 1; has(other: unknown) { return #value in other; } } new Box().has({});",
        "class Box { #value = 1; #value = 2; } new Box();",
        "class Box { declare #value: number; } new Box();",
        "class Box { #value = 1; constructor() { return {}; } } new Box();",
        "function factory() { return class Box { #value = 1; }; } new (factory())();",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{source}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains("SCN1001"), "{source}: {stderr}");
        assert!(!stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn private_fields_keep_declaration_identity_outside_public_layouts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.json");
    fs::write(&input, "class Base { #value = 1; get value(): number { return this.#value; } unused(): number { while (true) {} } } class Child extends Base { #value = 2; get own(): number { return this.#value; } } const child = new Child(); console.log(child.value, child.own);").unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--emit", "ir", "--out"])
            .arg(&output)
            .output()
            .unwrap(),
    );
    let ir: serde_json::Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    assert_eq!(ir["irVersion"], 13);
    for name in ["Base", "Child"] {
        let class = ir["classes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|class| class["jsName"] == name)
            .unwrap();
        assert!(class["fields"].as_array().unwrap().is_empty());
    }
    let slots = ir["globals"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|global| global["id"].as_str().unwrap().starts_with("%g.private."))
        .collect::<Vec<_>>();
    assert_eq!(slots.len(), 2);
    assert_ne!(slots[0]["id"], slots[1]["id"]);
    assert!(slots.iter().all(|global| {
        global["type"]["className"] == "native_builtin_WeakMap" && global["mutable"] == false
    }));
    assert!(
        !ir["functions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|function| function["name"].as_str().unwrap().ends_with(".unused"))
    );
}

#[test]
fn accessor_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "accessor-boundary");
    for source in [
        "class Box { get value() { return 1; } } new Box().value = 2;",
        "class Box { set value(value: number) {} } console.log(new Box().value);",
        "class Box { get value() { return 1; } set value(value: number) {} } new Box().value += 2;",
        "class Box { get value() { return 1; } set value(value: number) {} } console.log(new Box().value++);",
        "class Box { get value() { return 1; } } console.log(new Box()['value']);",
        "class Box { static get value() { return 1; } } console.log(Box.value);",
        "class Box { get ['value']() { return 1; } } new Box();",
        "class Box { get #value() { return 1; } } new Box();",
        "class Base { get value(): number { return 1; } set value(n: number) {} } class Child extends Base { get value(): number { return 2; } } const box: Base = new Child(); box.value = 3;",
        "class Base { get value(): number { return 1; } set value(n: number) {} } class Child extends Base { set value(n: number) {} } const box: Base = new Child(); console.log(box.value);",
        "class Base { get value(): number { return 1; } } class Child extends Base { get value(): any { return 'different'; } } const box: Base = new Child(); console.log(box.value);",
        "class Base { stored = 1; } class Child extends Base { get value(): number { return super.stored; } } console.log(new Child().value);",
        "// @ts-nocheck\nclass Base { get value() { return 1; } } class Child extends Base { value = 2; } new Child();",
        "// @ts-nocheck\nclass Base { value = 1; } class Child extends Base { get value() { return 2; } } new Child();",
        "// @ts-nocheck\nclass Base { get value() { return 1; } } class Child extends Base { value() { return 2; } } new Child();",
        "// @ts-nocheck\nclass Base { value() { return 1; } } class Child extends Base { get value() { return 2; } } new Child();",
    ] {
        // Exercise our native boundary even where TypeScript also rejects it.
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{source}");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(stderr.contains("SCN1001"), "{source}: {stderr}");
        assert!(!stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn accessors_keep_descriptor_surface_and_demand_only_used_bodies() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.json");
    fs::write(&input, "class Box { stored = 1; get value(): number { return this.stored; } set value(n: number) { this.stored = n; } get unused(): number { while (true) {} } } const box = new Box(); box.value = 2; console.log(box.value);").unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--emit", "ir", "--out"])
            .arg(&output)
            .output()
            .unwrap(),
    );
    let ir: serde_json::Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    assert_eq!(ir["irVersion"], 13);
    let classes = ir["classes"].as_array().unwrap();
    assert_eq!(classes.len(), 1);
    assert_eq!(
        classes[0]["methodNames"],
        serde_json::json!(["value", "unused"])
    );
    assert!(classes[0].get("methods").is_none());
    let fields = classes[0]["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0]["name"], "stored");
    let functions = ir["functions"].as_array().unwrap();
    for suffix in [".get:value", ".set:value"] {
        let function = functions
            .iter()
            .find(|f| f["name"].as_str().unwrap().ends_with(suffix))
            .unwrap();
        assert_eq!(function["params"][0]["name"], "this");
        assert_eq!(function["params"][0]["type"]["kind"], "object");
    }
    assert!(
        !functions
            .iter()
            .any(|f| f["name"].as_str().unwrap().ends_with(":unused"))
    );
}

#[test]
fn erased_method_names_keep_a_boundary_without_demanding_bodies() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    fs::write(&input, "class Box { unused(): number { while (true) {} } } const box: unknown = new Box(); try { const method = (box as any).unused; console.log('must not become undefined', method === undefined); } catch (error) { if (error instanceof TypeError) console.log(error.message); }").unwrap();
    let target = binary(temp.path(), "erased-method");
    let build = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&build);
    let ir: serde_json::Value =
        serde_json::from_slice(&fs::read(target.with_extension("ir.json")).unwrap()).unwrap();
    assert!(
        ir["classes"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |class| class["methodNames"] == serde_json::json!(["unused"])
                    && class.get("methods").is_none()
            )
    );
    assert!(
        !ir["functions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|function| function["name"].as_str().unwrap().ends_with(".unused"))
    );
    let actual = Command::new(target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .output()
        .unwrap();
    success(&actual);
    assert_eq!(
        String::from_utf8_lossy(&actual.stdout).trim(),
        "scriptc: erased instance method values require a receiver ABI"
    );
    assert!(actual.stderr.is_empty());
}

#[test]
fn uncaught_exceptions_run_finalizers_and_release_native_storage() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "uncaught");
    fs::write(&input, "const held = { value: 1 }; console.log('before'); try { throw new Error('stop'); } finally { console.log('cleanup', held.value); }").unwrap();
    let build = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&build);
    let expected = Command::new(oracle()).arg(&input).output().unwrap();
    let actual = Command::new(&target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .output()
        .unwrap();
    assert_eq!(expected.status.code(), Some(1));
    assert_eq!(actual.status.code(), expected.status.code());
    assert_eq!(actual.stdout, expected.stdout);
    for stderr in [&expected.stderr, &actual.stderr] {
        assert!(String::from_utf8_lossy(stderr).contains("Error: stop"));
    }
    assert!(!String::from_utf8_lossy(&actual.stderr).contains("heap audit"));
    assert!(!String::from_utf8_lossy(&actual.stderr).contains("panicked"));
}

#[test]
fn symbol_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "symbol-boundary");
    for source in [
        "const values = new Map<symbol, number>(); values.set(Symbol.iterator, 1);",
        "class C { *[Symbol.iterator]() { yield 1; } } new C()[Symbol.iterator]();",
        "class C { async *[Symbol.asyncIterator]() { yield 1; } } new C()[Symbol.asyncIterator]();",
        "class C { [Symbol.iterator]() { return 1; } } const method = new C()[Symbol.iterator]; console.log(method);",
        "class C { [Symbol.iterator]() { return 1; } } const value: any = new C(); console.log(value[Symbol.iterator]);",
        "class C { [Symbol.iterator]() { return 1; } } const value: any = [new C()]; console.log(value);",
        "const key = Symbol.iterator; class C { [key]() { return 1; } }",
        "function key(): symbol { console.log('key'); return Symbol.iterator; } class C { [key()]() { return 1; } }",
        "class C { static [Symbol.iterator]() { return 1; } }",
        "class C { get [Symbol.iterator]() { return 1; } }",
        "class C { [Symbol.toPrimitive]() { return 1; } }",
        "class C { [Symbol.iterator](x: number): number; [Symbol.iterator](x: number): number { return x; } } new C()[Symbol.iterator](1);",
        "export {}; const Symbol = { iterator: 'iterator' }; class C { [Symbol.iterator]() { return 1; } } console.log(new C());",
        "const value = { [Symbol.iterator]: 1 }; console.log(value);",
        "const value = Symbol.iterator; console.log(value[Symbol.toPrimitive]);",
        "const { iterator } = Symbol; console.log(iterator);",
        "const obj = { [Symbol('key')]: 1 }; console.log(obj);",
        "const factory = Symbol; const value = factory('key');",
        "const value = Symbol(1 as any);",
        "const value = Symbol('key'); console.log(`${value}`);",
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(!result.status.success());
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(
            error.contains("SCN1001") || error.contains("TS2731"),
            "{error}"
        );
        assert!(!error.contains("panicked"), "{error}");
        for artifact in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn codec_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::copy(
        root().join("tests/corpus/rust-native-codecs/tsconfig.json"),
        temp.path().join("tsconfig.json"),
    )
    .unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "boundary");
    for source in [
        "const codec = new TextDecoder('utf-16le');",
        "const codec = new TextDecoder('utf-8', { fatal: true });",
        "const codec = new TextDecoder(); codec.decode(new Uint8Array(), { stream: true });",
        "const codec = new TextEncoder(); codec.encodeInto('x', new Uint8Array(1));",
        "const codec = new TextEncoder(); const encode = codec.encode;",
        "const codec = new TextEncoder(); codec.encode(undefined);",
        "class Custom extends TextEncoder {}",
        "const bytes = new Uint8Array(1); console.log(bytes[99]);",
        "const bytes = new Uint8Array(1); bytes[0] = 2;",
        "const bytes = new Uint8Array(new ArrayBuffer(2));",
    ] {
        fs::write(&input, source).unwrap();
        fs::write(&target, "preserve").unwrap();
        let rust = target.with_extension("rs");
        let ir = target.with_extension("ir.json");
        fs::write(&rust, "preserve rust").unwrap();
        fs::write(&ir, "preserve ir").unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001"),
            "{source}: {stderr}"
        );
        assert!(
            !stderr.contains("panicked") && !stderr.contains("SCN9001"),
            "{source}: {stderr}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"preserve");
        assert_eq!(fs::read(&rust).unwrap(), b"preserve rust");
        assert_eq!(fs::read(&ir).unwrap(), b"preserve ir");
    }
}

#[test]
fn console_value_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::copy(
        root().join("tests/corpus/rust-native-console/tsconfig.json"),
        temp.path().join("tsconfig.json"),
    )
    .unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "console-boundary");
    for source in [
        "const print = console.log; print();",
        "const print = console.log; print(1);",
        "const print = console.log; print('one', 'two');",
        "const print = console.log; print({ value: 1 });",
        "const print: (n: number) => void = console.log; print(1);",
        "const print = console.log; console.log(print.length);",
        "const print = console.log; console.log(print.name);",
        "console.log('%s', 'formatted');",
        "console.log({ value: 1 });",
        "const instance = console; instance.log('object alias');",
        "console.log = (message: string): void => {};",
        "export {}; declare global { interface Console { log(message: string): number; } } const value = console.log('custom overload'); console.log(value);",
    ] {
        fs::write(&input, source).unwrap();
        fs::write(&target, "preserve").unwrap();
        let rust = target.with_extension("rs");
        let ir = target.with_extension("ir.json");
        fs::write(&rust, "preserve rust").unwrap();
        fs::write(&ir, "preserve ir").unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001"),
            "{source}: {stderr}"
        );
        assert!(
            !stderr.contains("panicked") && !stderr.contains("SCN9001"),
            "{source}: {stderr}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"preserve");
        assert_eq!(fs::read(&rust).unwrap(), b"preserve rust");
        assert_eq!(fs::read(&ir).unwrap(), b"preserve ir");
    }
    fs::write(
        temp.path().join("lib.dom.d.ts"),
        "interface Console { log(message: string): number; } declare var console: Console;",
    )
    .unwrap();
    fs::write(temp.path().join("tsconfig.json"), r#"{"compilerOptions":{"target":"ES2022","lib":["ES2022"],"types":[],"strict":true},"files":["main.ts","lib.dom.d.ts"]}"#).unwrap();
    fs::write(&input, "const print = console.log; print('fake library');").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        !result.status.success() && String::from_utf8_lossy(&result.stderr).contains("SCN1001")
    );
    assert_eq!(fs::read(&target).unwrap(), b"preserve");
}

#[test]
fn object_spread_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::copy(
        root().join("tests/corpus/rust-native-spreads/tsconfig.json"),
        temp.path().join("tsconfig.json"),
    )
    .unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "spread-boundary");
    for source in [
        "type S = { kind: 'a'; value: string } | { kind: 'b'; count: number }; type O = S & { flag: boolean }; function f(s: S): O { return { flag: true, ...s }; } console.log(f({kind:'a',value:'x'}).kind);",
        "type S = { kind: 'a'; value: string } | { kind: 'b'; count: number }; type O = S & { flag: boolean }; function f(s: S): O { return { ...s, ...{flag: true} }; } console.log(f({kind:'b',count:1}).kind);",
        "type S = { kind: 'a'; value: string } | { kind: 'b'; count: number }; type O = { kind: 'a'; value: string; f?: boolean } | { kind: 'a'; value: string; g?: string } | { kind: 'b'; count: number; f?: boolean }; function f(s: S): O { return { ...s }; } console.log(f({kind:'a',value:'x'}).kind);",
        "type S = { kind: 'a'; value: string } | { kind: 'b'; count: number }; type O = { kind: 'a'; value: number } | { kind: 'b'; count: number; value: number }; function f(s: S): O { return { ...s, value: 2 }; } console.log(f({kind:'a',value:'x'}).kind);",
        "const flag = false; const result: { a: string } = { ...(flag ? { a: 'a' } : ({} as { a: string })) }; console.log(result.a);",
        "function copy(source: { a: number; extra: string }): { a: string } { return { ...source } as unknown as { a: string }; } console.log(copy({ a: 1, extra: 'x' }).a);",
        "function copy(source: Record<string, string>) { return { a: 'a', ...source }; } console.log(copy({ b: 'b' }).a);",
        "const result: { a: string; b?: string } = { a: 'a', ...{ get b() { return 'b'; } } }; console.log(result.a);",
        "class C { a: string = 'a'; } const source = new C(); const result = { ...source }; console.log(result.a);",
        "const flag = true; const result: { a: string; b?: string } = { a: 'a', ...(flag && { b: 'b' }) }; console.log(result.a);",
        "const result: { a: string } = { a: 'a', ...{ __proto__: null } }; console.log(result.a);",
        "function key(): string { return 'b'; } const result: { a: string; b?: string } = { a: 'a', ...{ [key()]: 'b' } }; console.log(result.a);",
        "const key = Symbol('b'); const result = { a: 'a', ...{ [key]: 'b' } }; console.log(result.a);",
        "console.log(Object.keys(['a']).length);",
        "console.log(Object.hasOwn({ a: 'a' }, Symbol('a')));",
        "const value: { a: string; __proto__?: string } = { a: 'a' }; value.__proto__ = 'ignored'; console.log(Object.hasOwn(value, '__proto__'));",
        "const value: { a: string; __proto__?: string } = { a: 'a' }; value['__proto__'] = 'ignored'; console.log(Object.keys(value).length);",
    ] {
        fs::write(&input, source).unwrap();
        let rust = target.with_extension("rs");
        let ir = target.with_extension("ir.json");
        fs::write(&target, b"preserve").unwrap();
        fs::write(&rust, b"preserve rust").unwrap();
        fs::write(&ir, b"preserve ir").unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001"),
            "{source}: {stderr}"
        );
        assert!(
            !stderr.contains("panicked") && !stderr.contains("SCN9001"),
            "{source}: {stderr}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"preserve");
        assert_eq!(fs::read(&rust).unwrap(), b"preserve rust");
        assert_eq!(fs::read(&ir).unwrap(), b"preserve ir");
    }
}

#[test]
fn array_rest_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::copy(
        root().join("tests/corpus/rust-native-array-rest/tsconfig.json"),
        temp.path().join("tsconfig.json"),
    )
    .unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "array-rest-boundary");
    for source in [
        "class C { method(...items: string[]): number { return items.length; } } console.log(new C().method('x'));",
        "const f = (...items: [string, ...string[]]) => items.length; console.log(f('a'));",
        "console.log([1].map((...items: [number, number, number[]]) => items.length).length);",
        "function f(prefix: string, ...items: string[]): string { return prefix; } const bound = f.bind(null, 'prefix', 'tail'); console.log(bound());",
        "function f(...items: string[]): number { return items.length; } const source = ['a']; console.log(f(...source));",
        "const callback: (item: string) => string = (...items: string[]) => items.join('|'); console.log(callback('x'));",
        "const f = (...items: string[]) => items.join('|'); const ordinary = f as unknown as (items: string[]) => string; console.log(ordinary(['a']));",
        "class C { constructor(...items: string[]) {} } new C('x');",
        "function first<T>(...items: T[]) { return items[0]; } console.log(first<number>() === undefined);",
        "function first<T>(...items: T[]) { return items[0]; } const alias = first; console.log(alias(1));",
    ] {
        fs::write(&input, source).unwrap();
        for path in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            fs::write(path, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001"),
            "{source}: {stderr}"
        );
        assert!(
            !stderr.contains("panicked") && !stderr.contains("SCN9001"),
            "{source}: {stderr}"
        );
        for path in [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
        ] {
            assert_eq!(fs::read(path).unwrap(), b"preserve");
        }
    }
    fs::write(
        temp.path().join("bridge.d.ts"),
        "export function f(...items: string[]): string;",
    )
    .unwrap();
    fs::write(
        temp.path().join("bridge.js"),
        "export function f(items) { return items[0]; }",
    )
    .unwrap();
    fs::write(
        &input,
        "import { f } from './bridge.js'; console.log(f('x'));",
    )
    .unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        !result.status.success() && stderr.contains("rest ABI differs"),
        "{stderr}"
    );
    for path in [
        &target,
        &target.with_extension("rs"),
        &target.with_extension("ir.json"),
    ] {
        assert_eq!(fs::read(path).unwrap(), b"preserve");
    }
}

#[test]
fn owned_console_prelude_supports_standalone_callbacks() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("standalone.mts");
    fs::write(&input, "const print = console.log; function use(sink: (line: string) => void): void { sink('standalone callback'); } use(print); console.warn('standalone warning'); console.log('identity', print === console.log);").unwrap();
    let target = binary(temp.path(), "standalone");
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap(),
    );
    let expected = Command::new(oracle()).arg(&input).output().unwrap();
    let actual = Command::new(&target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .output()
        .unwrap();
    success(&expected);
    success(&actual);
    assert_eq!(actual.status.code(), expected.status.code());
    assert_eq!(actual.stdout, expected.stdout);
    assert_eq!(actual.stderr, expected.stderr);
}

#[test]
fn namespace_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(
        temp.path().join("dep.ts"),
        "export let value: number = 1; export function read(): number { return value; }",
    )
    .unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "namespace-boundary");
    for source in [
        "import * as ns from './dep.ts'; const alias = ns; const erased: unknown = alias;",
        "import * as ns from './dep.ts'; const alias = ns; console.log(Object.keys(alias));",
        "import * as ns from './dep.ts'; const alias = ns; console.log(alias['value']);",
        "import * as ns from './dep.ts'; const alias = ns; alias.value = 2;",
        "import * as ns from './dep.ts'; Promise.resolve(ns);",
        "import * as ns from './dep.ts'; const alias = ns; const record = { alias }; const erased: unknown = record;",
        "import * as ns from './dep.ts'; class Box { value: typeof ns = ns; } const erased: unknown = new Box();",
        "import * as ns from './dep.ts'; const callback = (): typeof ns => ns; const erased: unknown = callback;",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn satisfies_checks_unused_bodies_and_preserves_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "satisfies-boundary");
    for source in [
        "const invalid = 42 satisfies string;",
        "function unused() { return 42 satisfies string; }",
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("TS1360") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn async_suspension_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "async-boundary");
    for source in [
        "async function f(): Promise<number> { return await Promise.resolve(1); } f();",
        "const f = async (): Promise<number> => await Promise.resolve(1); f();",
        "async function f(): Promise<number> { return Promise.resolve(1); } f();",
        "async function* f() { yield 1; } f();",
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn lexical_initialization_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "lexical-boundary");
    for (source, expected) in [
        (
            "let value!: Map<string, number>; console.log(value);",
            "binding has no undefined representation",
        ),
        (
            "declare let value: string | undefined; console.log(value === undefined);",
            "ambient lexical declarations have no native storage",
        ),
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .arg("--no-engine")
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && stderr.contains(expected)
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn stats_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "stats-boundary");
    for source in [
        "statSync('unused', {bigint: true});",
        "statSync('unused', {throwIfNoEntry: false});",
        "statSync(1);",
        "statSync('unused').mode;",
        "const method = statSync('unused').isFile; method();",
        "statSync('unused').isFile(1);",
        "const value = statSync('unused'); value.size = 1;",
        "const value: unknown = statSync('unused'); console.log(value);",
        "const value: unknown = {snapshot: statSync('unused')}; console.log(value);",
        "const value: unknown = [statSync('unused')]; console.log(value);",
        "const value = statSync('unused'); console.log(value === statSync('unused'));",
        "const value: Stats[] = [statSync('unused')]; console.log(value.length);",
        "const value = new Map<string, Stats>(); value.set('key', statSync('unused'));",
        "const value: Record<string, Stats> = {key: statSync('unused')}; console.log(value.key.size);",
        "let value!: Stats; value = statSync('unused');",
        "const value = ({} as unknown) as Stats; console.log(value.size);",
        "const callback: () => unknown = () => statSync('unused'); callback();",
    ] {
        fs::write(
            &input,
            format!("// @ts-nocheck\nimport {{statSync, type Stats}} from 'node:fs';\n{source}\n"),
        )
        .unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn async_context_boundaries_preserve_existing_artifacts() {
    let parent = root().join(".scriptc");
    fs::create_dir_all(&parent).unwrap();
    let temp = tempfile::Builder::new()
        .prefix("async-context-boundary-")
        .tempdir_in(parent)
        .unwrap();
    fs::copy(
        root().join("tests/corpus/rust-native-async-context/tsconfig.json"),
        temp.path().join("tsconfig.json"),
    )
    .unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "boundary");
    for source in [
        "new AsyncLocalStorage<string>({ name: 'scope' });",
        "const store = new AsyncLocalStorage<string>(); store.enterWith('value');",
        "const store = new AsyncLocalStorage<string>(); store.disable();",
        "const store = new AsyncLocalStorage<string>(); store.exit(() => 1);",
        "const store = new AsyncLocalStorage<string>(); const run = store.run; run('value', () => 1);",
        "const value: unknown = new AsyncLocalStorage<string>();",
        "const value: unknown = { store: new AsyncLocalStorage<string>() };",
        "const value: unknown = [new AsyncLocalStorage<string>()];",
        "const store = new AsyncLocalStorage<string>(); const value: unknown = () => store;",
        "class Derived extends AsyncLocalStorage<string> {}",
    ] {
        fs::write(
            &input,
            format!("import {{ AsyncLocalStorage }} from 'node:async_hooks'; {source}"),
        )
        .unwrap();
        let artifacts = [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ];
        for artifact in artifacts {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && !stderr.contains("SCN9001")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn owning_set_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "owning-set-boundary");
    for source in [
        "const set = new Set<unknown>(['a', ...['b']]);",
        "const set = new Set<unknown>([,]);",
        "const seed: unknown[] = ['a']; const set = new Set<unknown>(seed);",
        "const seed = [() => 1]; const set = new Set(seed);",
        "const set = new Set<boolean>();",
        "const set = new Set<unknown>(); const value: unknown = set;",
        "const set = new Set<unknown>(); const value: unknown = { set };",
        "const set = new Set<unknown>(); set.values();",
    ] {
        fs::write(&input, source).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ];
        for artifact in artifacts {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && !stderr.contains("SCN9001")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn weak_map_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "weak-map-boundary");
    for source in [
        "const map = new WeakMap<object, number>([]);",
        "const map = new WeakMap<object, number>(); const get = map.get;",
        "const value: unknown = new WeakMap<object, number>();",
        "const value: unknown = { map: new WeakMap<object, number>() };",
        "class Derived extends WeakMap<object, number> {}",
        "const map = new WeakMap<object, number>(); map.set([], 1);",
        "const map = new WeakMap<object, number>(); map.set(() => 1, 1);",
        "const map = new WeakMap<object, number>(); map.set(/key/, 1);",
        "const map = new WeakMap<object, number>(); class Key {} map.set(new Key(), 1);",
        "const map = new WeakMap<object, number>(); map.get(...[{}] as [{}]);",
    ] {
        fs::write(&input, source).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ];
        for path in artifacts {
            fs::write(path, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && !stderr.contains("SCN9001")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in artifacts {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn file_url_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "metadata-boundary");
    for source in [
        "console.log(import.meta);",
        "console.log(import.meta.resolve('./x'));",
        "console.log(import.meta['url']);",
        "import.meta.url = 'file:///replacement';",
        "const { url } = import.meta; console.log(url);",
        "import { fileURLToPath } from 'node:url'; fileURLToPath('file:///C:/x', { windows: true });",
        "import { fileURLToPath } from 'node:url'; fileURLToPath(new URL('file:///x'));",
    ] {
        fs::write(&input, source).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ];
        for path in artifacts {
            fs::write(path, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && !stderr.contains("SCN9001")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for path in artifacts {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn unsupported_recursive_layouts_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "recursive-boundary");
    for source in [
        "type Chain = Chain[]; const chain: Chain = []; console.log(chain.length);",
        "type Chain = [Chain]; function use(value: Chain): number { return 1; } console.log(use);",
        "interface Bad { self: Bad; invalid: Map<string, number> | string; } function use(value: Bad): number { return 1; } console.log(use);",
        "interface Bad { self: Bad; method(): number; } function use(value: Bad): number { return 1; } console.log(use);",
        "interface A { next?: A; value: number; } interface B { next?: B; value: number; extra: string; } function use(value: A): number { return value.value; } const b: B = { value: 1, extra: 'required' }; console.log(use(b));",
        "interface A { children: A[]; value: number; } interface B { children: B[]; value: number; } function use(value: A): number { return value.value; } const b: B = { value: 1, children: [] }; console.log(use(b));",
    ] {
        fs::write(&input, source).unwrap();
        let artifacts = [
            target.clone(),
            target.with_extension("ir.json"),
            target.with_extension("rs"),
        ];
        for artifact in &artifacts {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && !stderr.contains("SCN9001")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in &artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn module_metadata_keeps_source_paths_after_changing_working_directory() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("source # % café.mts");
    fs::write(&input, "import { fileURLToPath } from 'node:url'; console.log(import.meta.url); console.log(import.meta.filename); console.log(import.meta.dirname); console.log(fileURLToPath(import.meta.url));").unwrap();
    let target = binary(temp.path(), "different-output-name");
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap(),
    );
    let cwd = temp.path().join("different cwd");
    fs::create_dir(&cwd).unwrap();
    let expected = Command::new(oracle())
        .arg(&input)
        .current_dir(&cwd)
        .output()
        .unwrap();
    let actual = Command::new(&target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .current_dir(&cwd)
        .output()
        .unwrap();
    success(&expected);
    success(&actual);
    assert_eq!(
        (actual.status.code(), actual.stdout, actual.stderr),
        (expected.status.code(), expected.stdout, expected.stderr)
    );
}

fn metadata_project(directory: &Path) {
    fs::write(directory.join("tsconfig.json"), serde_json::to_vec(&serde_json::json!({
        "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "lib": ["ES2022"], "types": ["node"], "typeRoots": [root().join("node_modules/@types")], "skipLibCheck": true, "strict": true }
    })).unwrap()).unwrap();
}

#[test]
fn builtin_manifest_reports_native_runtime_only_and_planned_contracts() {
    let result = Command::new(compiler()).arg("builtins").output().unwrap();
    success(&result);
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["engine"], "none");
    assert_eq!(report["fallback"], false);
    let apis = report["apis"].as_array().unwrap();
    for (module, member, stage) in [
        ("fs", "mkdirSync", "native-partial"),
        ("fs", "statSync", "native-partial"),
        ("fs", "lstatSync", "native-partial"),
        ("process", "env", "native-partial"),
        ("crypto", "createHash", "runtime-only"),
        ("Bun", "file", "planned"),
    ] {
        assert!(apis.iter().any(|row| row["module"] == module
            && row["member"] == member
            && row["stage"] == stage));
    }
    let bad = Command::new(compiler())
        .args(["builtins", "unexpected"])
        .output()
        .unwrap();
    assert!(!bad.status.success());
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let source = temp.path().join("main.mts");
    fs::write(&source, "import {mkdirSync} from 'node:fs'; import {createHash} from 'node:crypto'; mkdirSync('x', {recursive:true}); createHash('sha256');").unwrap();
    let output = temp.path().join("inspection.json");
    let result = Command::new(compiler())
        .arg("inspect")
        .arg(source)
        .arg("--out")
        .arg(&output)
        .output()
        .unwrap();
    success(&result);
    let report: serde_json::Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    assert_eq!(
        report["builtinCalls"]["fs.mkdirSync"]["signatureAvailable"],
        true
    );
    assert_eq!(
        report["builtinCalls"]["fs.mkdirSync"]["portStage"],
        "native-partial"
    );
    assert_eq!(
        report["builtinCalls"]["crypto.createHash"]["signatureAvailable"],
        false
    );
    assert_eq!(
        report["builtinCalls"]["crypto.createHash"]["portStage"],
        "runtime-only"
    );
    assert!(
        report["builtinCalls"]["fs.mkdirSync"]["nativeContract"]
            .as_str()
            .unwrap()
            .contains("Statement effects only")
    );
    assert!(!temp.path().join("x").exists());
}

#[test]
fn native_platform_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "platform-boundary");
    for (source, diagnostic) in [
        (
            "import { mkdirSync } from 'node:fs'; console.log(mkdirSync('x', { recursive: true }));",
            "first-created-directory",
        ),
        (
            "import { mkdirSync } from 'node:fs'; const options = { recursive: true }; mkdirSync('x', options);",
            "numeric modes",
        ),
        (
            "import { mkdirSync } from 'node:fs'; let recursive = true; mkdirSync('x', { recursive });",
            "boolean literal",
        ),
        (
            "import { mkdirSync } from 'node:fs'; mkdirSync(({ toString() { return 'x'; } }) as string);",
            "represented string paths",
        ),
        (
            "import { mkdirSync } from 'node:fs'; mkdirSync('x', { get mode() { return 448; } });",
            "plain recursive/mode properties",
        ),
        (
            "import { mkdirSync } from 'node:fs'; mkdirSync('x', { ...{ mode: 448 } });",
            "plain recursive/mode properties",
        ),
        (
            "import { mkdirSync } from 'node:fs'; mkdirSync(...['x']);",
            "iterable argument spreads",
        ),
        (
            "import { mkdirSync } from 'node:fs'; mkdirSync('x', undefined);",
            "numeric modes",
        ),
        (
            "import * as fs from 'node:fs'; fs.mkdirRecursiveModeSync('x', 448);",
            "not ported",
        ),
        (
            "import * as p from 'node:process'; p.isTTY(1);",
            "not ported",
        ),
        (
            "import { createHash } from 'node:crypto'; createHash('sha256');",
            "not ported",
        ),
        (
            "import { randomUUID } from 'node:crypto'; randomUUID({ disableEntropyCache: true });",
            "overload is not ported",
        ),
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        let artifacts = [
            target.clone(),
            target.with_extension("ir.json"),
            target.with_extension("rs"),
        ];
        for artifact in &artifacts {
            fs::write(artifact, "preserve").unwrap();
        }
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success()
                && stderr.contains("SCN1001")
                && stderr.contains(diagnostic)
                && !stderr.contains("SCN9001")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
        assert!(!temp.path().join("x").exists());
    }
}

#[test]
fn standard_primitive_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "primitive-boundary");
    for (source, expected) in [
        (
            "const value = { read(): string { return super.toString(); } }; value.read();",
            "object method super requires a native home-object contract",
        ),
        (
            "const value = { id<T>(input: T): T { return input; } }; value.id(1);",
            "generic and generator object methods are not ported",
        ),
        (
            "Math.floor({ valueOf: (): number => 2 } as any);",
            "standard numeric arguments require represented primitives",
        ),
        (
            "Math.floor({ valueOf: (): number => 2 } as unknown as number);",
            "standard numeric arguments require represented primitives",
        ),
        (
            "const values = [1, 2]; Math.min(...values);",
            "standard primitive iterable argument spreads are not ported",
        ),
        (
            "const values: [unknown] = [[]]; Array.isArray(...values);",
            "standard primitive iterable argument spreads are not ported",
        ),
        (
            "const values = [1]; String(...values);",
            "iterable call spreads are not ported",
        ),
        (
            "'x'.repeat(Symbol('count') as any);",
            "standard numeric arguments require represented primitives",
        ),
        (
            "'x'.slice({ valueOf: () => 1 } as any);",
            "standard numeric arguments require represented primitives",
        ),
        (
            "const value = { valueOf: () => 1 }; console.log(value + 'x');",
            "object ToPrimitive for string addition is not ported",
        ),
        (
            "console.log('x' + [1, 2]);",
            "object ToPrimitive for string addition is not ported",
        ),
        (
            "// @ts-nocheck\nconst key = { toString: () => 'rawJSON' }; console.log(key in JSON);",
            "object ToPropertyKey for standard object presence is not ported",
        ),
        (
            "export {}; const JSON = { rawJSON: false }; console.log('stringify' in JSON);",
            "in operator requires a proven standard JSON object",
        ),
        (
            "const data = {}; console.log('rawJSON' in data);",
            "in operator requires a proven standard JSON object",
        ),
        (
            "// @ts-nocheck\nconst value = JSON.rawJSON('1'); const alias = value; alias.rawJSON = '2';",
            "sloppy raw JSON writes require a native integrity contract",
        ),
    ] {
        fs::write(&input, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && stderr.contains(expected)
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn standard_primitive_declaration_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let declarations = temp.path().join("ambient.d.ts");
    let target = binary(temp.path(), "primitive-declarations");
    fs::write(&input, "Array.isArray(1);").unwrap();
    for source in [
        "interface ArrayConstructor { isArray(value: never): value is never; }",
        "declare var Array: { isArray(value: unknown): boolean };",
    ] {
        fs::write(&declarations, source).unwrap();
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success()
                && stderr.contains("SCN1001")
                && stderr.contains("call target has no native representation")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in [
            &target,
            &target.with_extension("ir.json"),
            &target.with_extension("rs"),
        ] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn utf16_instance_keys_do_not_alias_empty_fields() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    fs::write(
        &input,
        r#"
class EmptyField { "": string = "present"; }
function read(value: unknown, key: string): unknown { return (value as any)[key]; }
const high = "😀".slice(0, 1);
const object = new EmptyField();
console.log("keys", read(object, "") === "present", read(object, high) === undefined);
"#,
    )
    .unwrap();
    let target = binary(temp.path(), "utf16-keys");
    let build = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&build);
    let metadata: serde_json::Value = serde_json::from_slice(&build.stdout).unwrap();
    assert_eq!(metadata["engine"], "none");
    assert_eq!(metadata["compiler"], "rust");
    let expected = Command::new(oracle()).arg(&input).output().unwrap();
    let actual = Command::new(&target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .output()
        .unwrap();
    success(&expected);
    assert_eq!(actual.status.code(), expected.status.code());
    assert_eq!(actual.stdout, expected.stdout);
    assert_eq!(actual.stderr, expected.stderr);
}
