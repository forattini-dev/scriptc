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
        "rust-native-symbol-maps/values.ts",
        "rust-native-symbol-maps/record.ts",
        "rust-native-symbol-maps/seed.ts",
        "rust-native-symbol-maps/public.mts",
        "rust-native-symbol-maps/reassign.mts",
        "rust-native-symbol-property-read/ordinary.ts",
        "rust-native-derived-guards/values.ts",
        "rust-native-contextual-record-storage/values.ts",
        "rust-native-static-methods/values.ts",
        "rust-native-class-property-constructor/values.ts",
        "rust-native-class-union/values.ts",
        "rust-native-class-data/values.ts",
        "rust-native-static-methods/inheritance.ts",
        "rust-native-static-methods/order.ts",
        "rust-native-static-methods/public.mts",
        "rust-native-unobserved-default/main.ts",
        "rust-native-unobserved-default/entry.ts",
        "rust-native-writable-abi/identity.ts",
        "rust-native-writable-abi/shadows.ts",
        "rust-native-writable-abi/public.mts",
        "rust-native-process/brackets.ts",
        "rust-native-global-numbers/values.ts",
        "rust-native-global-numbers/shadows.ts",
        "rust-native-assignment-expressions/values.ts",
        "rust-native-assignment-expressions/errors.ts",
        "rust-native-record-index-values/values.ts",
        "rust-native-record-index-values/order.ts",
        "rust-native-asserted-index/values.ts",
        "rust-native-int32-arrays/values.ts",
        "rust-native-int32-arrays/dataview.ts",
        "rust-native-recursive-closures/callbacks.ts",
        "rust-native-recursive-closures/escaping.ts",
        "rust-native-recursive-closures/defaults.ts",
        "rust-native-dataview/values.ts",
        "rust-native-dataview/order.ts",
        "rust-native-dataview/bounds.ts",
        "rust-native-optional-views/contracts.ts",
        "rust-native-optional-views/identity.ts",
        "rust-native-optional-views/callbacks.ts",
        "rust-native-optional-views/order.ts",
        "rust-native-optional-views/nullable.ts",
        "rust-native-record-overrides/contracts.ts",
        "rust-native-record-overrides/order.ts",
        "rust-native-record-overrides/identity.ts",
        "rust-native-record-overrides/aliases.js",
        "rust-native-record-overrides/context.ts",
        "rust-native-aggregate-slots/contracts.ts",
        "rust-native-aggregate-slots/aliases.js",
        "rust-native-aggregate-slots/callbacks.ts",
        "rust-native-aggregate-slots/order.ts",
        "rust-native-aggregate-slots/identity.ts",
        "rust-native-function-source/contracts.ts",
        "rust-native-function-source/effects.ts",
        "rust-native-function-source/aliases.js",
        "rust-native-function-source/shadows.ts",
        "rust-native-function-source/raw.ts",
        "rust-native-regex-replace/contracts.ts",
        "rust-native-regex-replace/state.ts",
        "rust-native-regex-replace/effects.ts",
        "rust-native-regex-replace/aliases.js",
        "rust-native-string-identity/contracts.ts",
        "rust-native-string-identity/effects.ts",
        "rust-native-string-identity/aliases.js",
        "rust-native-string-identity/shadows.ts",
        "rust-native-bigint/values.ts",
        "rust-native-bigint/storage.ts",
        "rust-native-bigint/errors.ts",
        "rust-native-bigint/json.ts",
        "rust-native-bigint/raw-json.ts",
        "rust-native-rest-entry/contracts.ts",
        "rust-native-rest-entry/effects.ts",
        "rust-native-rest-entry/captures.ts",
        "rust-native-rest-entry/compatibility.ts",
        "rust-native-record-abi/contracts.js",
        "rust-native-record-abi/aliases.js",
        "rust-native-record-abi/effects.js",
        "rust-native-record-abi/pop.ts",
        "rust-native-js-parameter-abi/contracts.js",
        "rust-native-js-parameter-abi/discard.js",
        "rust-native-js-parameter-abi/aliases.js",
        "rust-native-js-parameter-abi/order.js",
        "rust-native-array-length/contracts.ts",
        "rust-native-array-length/errors.ts",
        "rust-native-array-length/aliases.ts",
        "rust-native-array-length/queries.ts",
        "rust-native-relational/contracts.ts",
        "rust-native-relational/effects.ts",
        "rust-native-relational/unions.ts",
        "rust-native-updates/contracts.ts",
        "rust-native-updates/references.ts",
        "rust-native-updates/conversions.ts",
        "rust-native-loops/contracts.ts",
        "rust-native-loops/captures.ts",
        "rust-native-loops/finally.ts",
        "rust-native-weak-sets/contracts.ts",
        "rust-native-weak-sets/order.ts",
        "rust-native-weak-sets/shadows.ts",
        "rust-native-object-keys/contracts.ts",
        "rust-native-object-keys/order.ts",
        "rust-native-object-keys/shadows.ts",
        "rust-native-boxed/contracts.ts",
        "rust-native-boxed/identity.ts",
        "rust-native-boxed/methods.ts",
        "rust-native-boxed/shadows.ts",
        "rust-native-process-writes/contracts.ts",
        "rust-native-process-writes/callbacks.ts",
        "rust-native-process-writes/order.ts",
        "rust-native-array-spread/contracts.ts",
        "rust-native-array-spread/order.ts",
        "rust-native-array-spread/identity.ts",
        "rust-native-optional-access/contracts.ts",
        "rust-native-optional-access/effects.ts",
        "rust-native-optional-access/chains.ts",
        "rust-native-tuple-includes/contracts.ts",
        "rust-native-optional-dynamic-record/values.ts",
        "rust-native-bytes-tuple-set/values.ts",
        "rust-native-array-reduce/values.ts",
        "rust-native-conditional-absence/values.ts",
        "rust-native-parameter-absence/values.ts",
        "rust-native-return-absence/values.ts",
        "rust-native-absence-assignment/values.ts",
        "rust-native-bytes-conditional/values.ts",
        "rust-native-bytes-undefined-key/values.ts",
        "rust-native-zlib/values.ts",
        "rust-native-for-of-presence/values.ts",
        "rust-native-tuple-array-includes/values.ts",
        "rust-native-tuple-includes/order.ts",
        "rust-native-numeric-dictionaries/contracts.ts",
        "rust-native-numeric-dictionaries/coalesce.ts",
        "rust-native-numeric-dictionaries/storage.ts",
        "rust-native-platform/read-file.ts",
        "rust-native-platform/read-file-errors.ts",
        "rust-native-platform/append.ts",
        "rust-native-platform/append-errors.ts",
        "rust-native-platform/mkdir.ts",
        "rust-native-platform/paths.ts",
        "rust-native-platform/crypto.ts",
        "rust-native-platform/stats.ts",
        "rust-native-platform/stat-errors.ts",
        "rust-native-platform/descriptors.ts",
        "rust-native-platform/buffers.ts",
        "rust-native-platform/buffer-errors.ts",
        "rust-native-platform/descriptor-errors.ts",
        "rust-native-codecs/indexing.ts",
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
        "rust-native-declaration-abi/nominal.ts",
        "rust-native-declaration-abi/open.ts",
        "rust-native-declaration-abi/plugin.ts",
        "rust-native-declaration-abi/containers.ts",
        "rust-native-declaration-abi/generic.ts",
        "rust-native-declaration-abi/errors.ts",
        "rust-native-declaration-abi/hierarchy.ts",
        "rust-native-regex-functions/identity.ts",
        "rust-native-regex-functions/receivers.ts",
        "rust-native-regex-functions/errors.ts",
        "rust-native-regex-functions/order.ts",
        "rust-native-regex-functions/shadows.ts",
        "rust-native-number-predicates/values.ts",
        "rust-native-number-predicates/order.ts",
        "rust-native-number-predicates/aliases.ts",
        "rust-native-regex-exec/captures.ts",
        "rust-native-regex-exec/state.ts",
        "rust-native-regex-exec/unicode.ts",
        "rust-native-regex-exec/optional.ts",
        "rust-native-sequence-methods/nullable-string.ts",
        "rust-native-sequence-methods/nullable-errors.ts",
        "rust-native-sequence-methods/nullable-order.ts",
        "rust-native-sequence-methods/some.ts",
        "rust-native-sequence-methods/slice.ts",
        "rust-native-sequence-methods/sparse.ts",
        "rust-native-sequence-methods/callbacks.ts",
        "rust-native-sequence-methods/order.ts",
        "rust-native-function-properties/aliases.ts",
        "rust-native-function-properties/closures.ts",
        "rust-native-function-properties/keys.ts",
        "rust-native-function-properties/order.ts",
        "rust-native-function-properties/imports.ts",
        "rust-native-function-properties/public.ts",
        "rust-native-parameter-patterns/typed.ts",
        "rust-native-parameter-patterns/order.ts",
        "rust-native-parameter-patterns/aliases.ts",
        "rust-native-parameter-patterns/dynamic.ts",
        "rust-native-parameter-patterns/width.ts",
        "rust-native-parameter-patterns/callbacks.ts",
        "rust-native-parameter-patterns/errors.ts",
        "rust-native-parameter-patterns/imports.ts",
        "rust-native-parameter-patterns/public.ts",
        "rust-native-replace-callback/captures.ts",
        "rust-native-replace-callback/state.ts",
        "rust-native-replace-callback/order.ts",
        "rust-native-replace-callback/values.ts",
        "rust-native-replace-callback/unicode.ts",
        "rust-native-replace-callback/named.ts",
        "rust-native-replace-callback/aliases.ts",
        "rust-native-string-index/units.ts",
        "rust-native-string-index/keys.ts",
        "rust-native-string-index/storage.ts",
        "rust-native-string-index/order.ts",
        "rust-native-string-index/optional.ts",
        "rust-native-delete/records.ts",
        "rust-native-delete/order.ts",
        "rust-native-delete/arrays.ts",
        "rust-native-delete/typed-alias.ts",
        "rust-native-buffer-byte-length/main.ts",
        "rust-native-delete/keys.ts",
        "rust-native-delete/errors.ts",
        "rust-native-delete/sloppy.cjs",
        "rust-native-delete/dictionary.ts",
        "rust-native-delete/raw.ts",
        "rust-native-object-bindings/holder.ts",
        "rust-native-object-bindings/contracts.ts",
        "rust-native-object-bindings/identity.ts",
        "rust-native-object-bindings/order.ts",
        "rust-native-object-bindings/module.ts",
        "rust-native-object-bindings/presence.ts",
        "rust-native-object-rest-local/main.ts",
        "rust-native-array-rest/main.ts",
        "rust-native-array-find/main.ts",
        "rust-native-for-loops/counting.ts",
        "rust-native-for-loops/order.ts",
        "rust-native-for-loops/finally.ts",
        "rust-native-for-loops/var.ts",
        "rust-native-computed-records/read.ts",
        "rust-native-computed-records/order.ts",
        "rust-native-computed-records/optional.ts",
        "rust-native-computed-records/write.ts",
        "rust-native-computed-records/views.ts",
        "rust-native-number-string/contracts.ts",
        "rust-native-number-string/order.ts",
        "rust-native-number-string/errors.ts",
        "rust-native-json-reviver/source.ts",
        "rust-native-json-reviver/delete.ts",
        "rust-native-json-reviver/mutations.ts",
        "rust-native-json-reviver/effects.ts",
        "rust-native-json-reviver/presence.ts",
        "rust-native-json-reviver/feature.ts",
        "rust-native-json-reviver/bigint.ts",
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
        "rust-native-number-constructor/values.ts",
        "rust-native-object-storage/grow.mjs",
        "rust-native-object-storage/modules.mjs",
        "rust-native-object-storage/nullable.ts",
        "rust-native-object-storage/order.ts",
        "rust-native-object-storage/dynamic-order.mjs",
        "rust-native-object-storage/contracts.ts",
        "rust-native-object-storage/captures.ts",
        "rust-native-number-constructor/bigint.ts",
        "rust-native-number-constructor/aliases.ts",
        "rust-native-number-constructor/order.ts",
        "rust-native-number-constructor/bind.ts",
        "rust-native-number-constructor/layouts.ts",
        "rust-native-array-every/values.ts",
        "rust-native-array-every/sparse.ts",
        "rust-native-array-every/order.ts",
        "rust-native-json-assets/identity.ts",
        "rust-native-json-assets/mutations.ts",
        "rust-native-json-assets/primitives.ts",
        "rust-native-json-assets/roots.ts",
        "rust-native-json-assets/order.ts",
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
        "rust-native-parameter-properties/values.ts",
        "rust-native-parameter-properties/order.ts",
        "rust-native-parameter-properties/errors.ts",
        "rust-native-number-parsers/values.ts",
        "rust-native-number-parsers/grammar.ts",
        "rust-native-number-parsers/aliases.ts",
        "rust-native-number-parsers/order.ts",
        "rust-native-number-parsers/errors.ts",
        "rust-native-object-presence/records.ts",
        "rust-native-has-own-call/values.ts",
        "rust-native-object-presence/keys.ts",
        "rust-native-object-presence/effects.ts",
        "rust-native-object-presence/json.ts",
        "rust-native-object-presence/groups.ts",
        "rust-native-object-presence/caught.ts",
        "rust-native-object-presence/raw.ts",
        "rust-native-for-of/values.ts",
        "rust-native-for-of/mutations.ts",
        "rust-native-for-of/captures.ts",
        "rust-native-for-of/strings.ts",
        "rust-native-for-of/control.ts",
        "rust-native-for-of/erased.ts",
        "rust-native-for-of/typed-views.ts",
        "rust-native-switch/values.ts",
        "rust-native-switch/order.ts",
        "rust-native-switch/control.ts",
        "rust-native-switch/ownership.ts",
        "rust-native-tuple-functions/values.ts",
        "rust-native-tuple-functions/storage.ts",
        "rust-native-tuple-functions/rows.ts",
        "rust-native-tuple-functions/effects.ts",
        "rust-native-math-erased/values.ts",
        "rust-native-math-erased/effects.ts",
        "rust-native-object-method-contracts/main.ts",
        "rust-native-nullish-equality/main.ts",
        "rust-native-array-includes/main.ts",
        "rust-native-array-at/values.ts",
        "rust-native-array-at/default.mjs",
        "rust-native-array-sort/values.ts",
        "rust-native-string-spread/main.ts",
        "rust-native-string-split/main.ts",
        "rust-native-regex-split/values.ts",
        "rust-native-regex-match/values.ts",
        "rust-native-optional-split/values.ts",
        "rust-native-regex-guard/direct.ts",
        "rust-native-set-spread/main.ts",
        "rust-native-set-spread/identity.ts",
        "rust-native-set-immediate-first/values.ts",
        "rust-native-set-immediate-first/dynamic.ts",
        "rust-native-set-immediate-first/custom.ts",
        "rust-native-dynamic-dictionary/main.ts",
        "rust-native-local-call-abi/values.mjs",
        "rust-native-local-call-abi/effects.mjs",
        "rust-native-local-call-abi/completion.mjs",
        "rust-native-local-call-abi/callbacks.ts",
        "rust-native-local-call-abi/default-options.mjs",
        "rust-native-local-call-abi/catalog-errors.ts",
        "rust-native-buffer-from/protocols.ts",
        "rust-native-buffer-from/unicode.ts",
        "rust-native-numeric-binary/values.ts",
        "rust-native-numeric-binary/errors.ts",
        "rust-native-numeric-binary/effects.ts",
        "rust-native-numeric-binary/storage.ts",
        "rust-native-numeric-binary/addition.ts",
        "rust-native-numeric-binary/caught.ts",
        "rust-native-numeric-binary/hoisting.ts",
        "rust-native-sequence-bindings/unit-effects.ts",
        "rust-native-sequence-bindings/values.ts",
        "rust-native-sequence-bindings/absence.ts",
        "rust-native-sequence-bindings/strings.ts",
        "rust-native-sequence-bindings/bytes.ts",
        "rust-native-sequence-bindings/parameters.ts",
        "rust-native-sequence-bindings/iteration.ts",
        "rust-native-sequence-bindings/storage.ts",
        "rust-native-buffer-from/values.ts",
        "rust-native-buffer-from/order.ts",
        "rust-native-buffer-from/errors.ts",
        "rust-native-tuple-index/values.ts",
        "rust-native-tuple-index/effects.ts",
        "rust-native-tuple-index/storage.ts",
        "rust-native-dynamic-bindings/values.ts",
        "rust-native-dynamic-bindings/primitives.ts",
        "rust-native-dynamic-bindings/order.ts",
        "rust-native-number-fixed/values.ts",
        "rust-native-number-fixed/order.ts",
        "rust-native-number-fixed/errors.ts",
        "rust-native-conditional/values.ts",
        "rust-native-conditional/effects.ts",
        "rust-native-conditional/guards.ts",
        "rust-native-conditional/compound-numeric.ts",
        "rust-native-conditional/compound-effects.ts",
        "rust-native-conditional/compound-absence.ts",
        "rust-native-presence-guards/strings.ts",
        "rust-native-presence-guards/compound.ts",
        "rust-native-presence-guards/effects.ts",
        "rust-native-presence-guards/parentheses.ts",
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
            .args(
                name.starts_with("rust-native-parameter-properties/")
                    .then_some("--experimental-transform-types"),
            )
            .args(
                name.starts_with("rust-native-parameter-properties/")
                    .then_some("--disable-warning=ExperimentalWarning"),
            )
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
    fs::write(temp.path().join("package.json"), r#"{"type":"module"}"#).unwrap();
    let input = temp.path().join("unsupported.js");
    for (source, reason) in [
        (
            "import * as data from './data.json' with {type:'json'}; console.log(data);",
            "only JSON default imports",
        ),
        (
            "import {value} from './data.json' with {type:'json'}; console.log(value);",
            "only JSON default imports",
        ),
        (
            "export {default} from './data.json' with {type:'json'};",
            "JSON re-exports",
        ),
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
            !result.status.success() && stderr.contains("SCN1001") && stderr.contains(reason),
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
fn computed_record_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "computed-record-boundary");
    for source in [
        "const data = {value: 1}; let key: string = 'value'; data[key] = 2;",
        "const data = {value: 1}; const key = {toString: () => 'value'}; data[key as any];",
        "const data = {value: new Set([1])}; let key: string = 'value'; data[key];",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
fn for_loop_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "for-loop-boundary");
    for source in [
        "for (let i = 0; i < 2; i++) { const fn = () => i; fn(); }",
        "for (let i = 0; (() => i < 2)(); i++) {}",
        "for (let i = 0; i < 2; i++) { const fn = () => ({i}); fn(); }",
        "for (let {i} = {i: 0}; i < 2; i++) { const fn = () => i; fn(); }",
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
            !output.status.success()
                && stderr.contains("SCN1001")
                && stderr.contains("per-iteration native cells")
                && !stderr.contains("panicked"),
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
fn string_index_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "string-index-boundary");
    for source in [
        "const text = 'abc'; const key = {toString: () => '0'}; text[key as unknown as number];",
        "function read(text: string, key: string) { return text[key]; } read('abc', '0');",
        "const text = 'abc'; let key: any = 0; text[key];",
        "const text = 'abc'; text[Symbol.iterator];",
        "const text = 'abc'; const method = text['trim']; method();",
        "function read(text: string, index: number): string { return text[index]; } read('', 0);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
fn buffer_byte_length_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "buffer-byte-length-boundary");
    for source in [
        "Buffer.byteLength('x', 'utf16le');",
        "Buffer.byteLength(new Uint8Array([1]));",
        "Buffer.byteLength(42);",
        "Buffer.byteLength();",
        "Buffer.byteLength(...['x']);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn erased_delete_non_optional_array_remains_explicitly_unsupported() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "non-optional-array-delete");
    for source in [
        "const values: number[] = [1]; const alias: any = values; delete alias[0];",
        "const values: ([number, number] | undefined)[] = [[1, 2]]; const alias: any = values; delete alias[0];",
    ] {
        fs::write(&input, source).unwrap();
        let build = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            build.status.success(),
            "{}",
            String::from_utf8_lossy(&build.stderr)
        );
        let output = Command::new(&target).output().unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("native property deletion on this specialized value is not ported")
        );
    }
}

#[test]
fn deletion_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "deletion-boundary");
    for source in [
        "const data = {value: 1}; delete data.value;",
        "const data = {value: 1}; let key: string = 'value'; delete data[key];",
        "const data = [1]; delete data[0];",
        "const data = JSON.parse('{}'); let key: any = 'x'; delete data[key];",
        "const data = JSON.parse('{}'); const key = {toString: () => 'x'}; delete data[key as any];",
        "const data = JSON.parse('{}'); delete data[Symbol('key')];",
        "const data = JSON.parse('{}'); delete data?.x;",
        "const data = new Set([1]); delete data.size;",
        "delete (console.log('effect'), 1);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
fn object_binding_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "object-binding-boundary");
    for source in [
        "const {x = 1} = {x: undefined};",
        "const {x: {y}} = {x: {y: 1}};",
        "const {['x']: x} = {x: 1};",
        "const {x = 1} = JSON.parse('{}');",
        "const values: Record<string, string> = {x: 'x'}; const {...rest} = values;",
        "const {x}: {x: number} = {x: 1};",
        "var {x} = {x: 1};",
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
        (
            "regex-compile",
            "const pattern = /x/; pattern.compile('x');",
        ),
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
    fs::write(&input, "for (;;) {}").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("SCN1001"));
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
fn json_aggregate_mutations_use_shared_owning_values() {
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
        .arg("--no-engine")
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    success(&result);
    let metadata: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(metadata["compiler"], "rust");
    assert_eq!(metadata["engine"], "none");
    let actual = Command::new(&target).output().unwrap();
    success(&actual);
    assert_eq!(actual.stdout, b"changed\n");
    assert!(actual.stderr.is_empty());
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
            "export function value(n) { outer: while (n) { break outer; } return 1; }",
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
        true
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
        "class Box { constructor(...values: number[]) {} } new Box(1);",
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
fn static_method_boundaries_are_refused_without_publication() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.ir.json");
    for source in [
        "class C { static f() { return this; } } C.f();",
        "class A { static f() { return 1; } } class B extends A { static f() { return super.f(); } } B.f();",
        "class C { static f() { return 1; } } const method = C.f; console.log(method());",
        "class C { static f() { return 1; } } const alias = C; console.log(alias.f());",
        "class C { static f() { return 1; } } const value: any = C; console.log(value.f);",
        "class A { static f() { return 1; } } class B extends A {} const value: any = B; console.log(value.f);",
        "class C { static f() { return 1; } } C.f = () => 2; console.log(C.f());",
        "class C { static f(value: string): string; static f(value: number): number; static f(value: any): any { return value; } } C.f(1);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        fs::write(&output, "preserve").unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(&output)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("SCN1001"),
            "{source}: {stderr}"
        );
        assert_eq!(fs::read_to_string(&output).unwrap(), "preserve");
    }
}

#[test]
fn observed_default_expression_is_refused_without_publication() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.mts");
    let entry = temp.path().join("entry.mts");
    let output = temp.path().join("entry.ir.json");
    fs::write(temp.path().join("tsconfig.json"), r#"{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","allowImportingTsExtensions":true,"strict":true}}"#).unwrap();
    fs::write(
        &source,
        "export let value = 1; export default value; value = 2;",
    )
    .unwrap();
    for text in [
        "import value from './source.mts'; console.log(value);",
        "import { default as value } from './source.mts'; console.log(value);",
        "import * as source from './source.mts'; console.log(source.default);",
        "export { default as value } from './source.mts';",
        "export * as source from './source.mts';",
    ] {
        fs::write(&entry, text).unwrap();
        fs::write(&output, "preserve").unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&entry)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(&output)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success() && stderr.contains("ExportAssignment"),
            "{text}: {stderr}"
        );
        assert_eq!(fs::read_to_string(&output).unwrap(), "preserve");
    }
}

#[test]
fn ordinary_property_assignment_expression_is_refused_without_publication() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.ir.json");
    fs::write(&input, "function run(): void { const box = { value: 0 }; let x = 0; console.log(x = box.value = 2); } run();").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(&output)
        .arg("--no-engine")
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("binary operator is not ported"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!output.exists());
}

#[test]
fn asserted_index_in_unplanned_record_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.ir.json");
    fs::write(&input, "interface Point { x: number } function run(): void { const values = new Int32Array(0); const point: Point = { x: values[0]! }; console.log(point.x); } run();").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(&output)
        .arg("--no-engine")
        .output()
        .unwrap();
    assert!(!result.status.success(), "unplanned record compiled");
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("coercion is not ported"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!output.exists());
}

#[test]
fn asserted_module_index_refuses_unrepresentable_storage() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.ir.json");
    fs::write(
        &input,
        "const bytes = new Uint8Array(0); const value = bytes[0]!; console.log(value);",
    )
    .unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(&output)
        .arg("--no-engine")
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("module binding layout differs"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!output.exists());
}

#[test]
fn int32_dynamic_boundary_is_refused_without_engine() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.ir.json");
    for source in [
        "const value: unknown = new Int32Array([1]); console.log(value);",
        "const value: unknown = new Uint32Array([1]); console.log(value);",
        "const value: unknown = 1; console.log((value as Int32Array).length);",
        "function run(): void { const f = (a: Int32Array): number => a.length ? f(a) : 0; console.log(f(new Int32Array(0))); } run();",
    ] {
        fs::write(&input, source).unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--emit", "ir", "--out"])
            .arg(&output)
            .arg("--no-engine")
            .output()
            .unwrap();
        assert!(!result.status.success(), "{source} unexpectedly compiled");
        assert!(
            String::from_utf8_lossy(&result.stderr).contains("32-bit integer typed array"),
            "{source}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(!output.exists());
    }
}

#[test]
fn recursive_const_closures_reject_source_reassignment() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.ir.json");
    fs::write(&input, "function run(): void { const f = (n: number): number => n ? f(n - 1) : 0; f = (n: number): number => n; console.log(f(1)); } run();").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--emit", "ir", "--out"])
        .arg(&output)
        .arg("--no-engine")
        .output()
        .unwrap();
    assert!(!result.status.success());
    let diagnostic = String::from_utf8_lossy(&result.stderr);
    assert!(
        diagnostic.contains("immutable binding") || diagnostic.contains("TS2588"),
        "{diagnostic}"
    );
    assert!(!output.exists());
}

#[test]
fn data_view_brand_boundaries_are_refused_without_engine() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("tsconfig.json"), r#"{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"types":[],"lib":["ES2022","DOM"]}}"#).unwrap();
    let input = temp.path().join("main.ts");
    let output = temp.path().join("main.ir.json");
    let prefix = "const bytes = new Uint8Array(8); const view = new DataView(bytes.buffer); ";
    for (source, expected) in [
        (
            "const value: unknown = view; console.log(value);",
            "DataView",
        ),
        ("console.log(Object.keys(view));", "DataView"),
        ("const {...rest} = view; console.log(rest);", "DataView"),
        (
            "console.log(view['\\0scriptc.dataview.storage']);",
            "DataView",
        ),
        (
            "const method = view.getUint16; console.log(method);",
            "DataView",
        ),
        ("console.log(view.getBigUint64(0));", "DataView"),
    ] {
        fs::write(&input, format!("{prefix}{source}")).unwrap();
        let result = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--emit", "ir", "--out"])
            .arg(&output)
            .arg("--no-engine")
            .output()
            .unwrap();
        assert!(!result.status.success(), "{source} unexpectedly compiled");
        assert!(
            String::from_utf8_lossy(&result.stderr).contains(expected),
            "{source}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(!output.exists(), "{source} published output after refusal");
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
fn contextual_record_storage_refuses_aliased_or_effectful_sources() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "contextual-record-boundary");
    for source in [
        "const worker={warnings:[],budget:{memory:'2G'}}; use([worker]); console.log(worker.budget.memory);",
        "const budget={memory:'2G'}; const worker={warnings:[],budget}; use([worker]);",
        "const worker={warnings:[],budget:{memory:'2G'}}; use([worker,worker]);",
        "export const worker={warnings:[],budget:{memory:'2G'}}; use([worker]);",
        "const worker={warnings:[],budget:{memory:'2G'}}; export { worker }; use([worker]);",
        "function make(){return {memory:'2G'};} const worker={warnings:[],budget:make()}; use([worker]);",
    ] {
        let prefix = "interface Budget { memory?: string; high?: string } interface Worker { warnings: string[]; budget?: Budget; extra?: number } function use(workers: Worker[]) { console.log(workers.length); } ";
        fs::write(&input, format!("{prefix}{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
fn derived_guard_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "derived-guard-boundary");
    for source in [
        "function g(x:number){return x;} function f(input:number|null,n:number){let x=input; const d=x==null?0:n; return d===0?0:g(x!);} console.log(f(null,2));",
        "function g(x:number){return x;} function f(input:number|null,n:number){const x=input; let d=x==null?0:n; d=1; return d===0?0:g(x!);} console.log(f(null,2));",
        "function g(x:number){return x;} function f(input:number|null,n:number){const x=input; const d=x==null?1:n; return d===0?0:g(x!);} console.log(f(null,2));",
        "function g(a:number,x:number){return a+x;} function f(input:number|null,n:number){const x=input; const d=x==null?0:n; return d===0?0:g(Math.random(),x!);} console.log(f(null,2));",
        "function g(x:number){return x;} function f(input:number|null|undefined,n:number){const x=input; const d=x===null?0:n; return d===0?0:g(x!);} console.log(f(undefined,2));",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
fn symbol_reads_on_erased_exotic_receivers_fail_explicitly() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "symbol-exotic-boundary");
    fs::write(&input, "const value: any = [1]; try { console.log(value[Symbol.iterator] === undefined); } catch (error) { console.log((error as Error).message); }\n").unwrap();
    let result = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let output = Command::new(&target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "scriptc: symbol property access on this native value is not supported yet"
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn symbol_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "symbol-boundary");
    for source in [
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
        "function copy(flag: boolean): { a: string } { return { ...(flag ? { a: 'x' } : { a: 1 }) } as unknown as { a: string }; } console.log(copy(true).a);",
        "function copy(source: { a?: number }): { a: string } { return { a: 'x', ...source } as unknown as { a: string }; } console.log(copy({}).a);",
        "function copy(source: Record<string, string>) { return { a: 'a', ...source }; } console.log(copy({ b: 'b' }).a);",
        "const result: { a: string; b?: string } = { a: 'a', ...{ get b() { return 'b'; } } }; console.log(result.a);",
        "class C { a: string = 'a'; } const source = new C(); const result = { ...source }; console.log(result.a);",
        "const flag = true; const result: { a: string; b?: string } = { a: 'a', ...(flag && { b: 'b' }) }; console.log(result.a);",
        "const result: { a: string } = { a: 'a', ...{ __proto__: null } }; console.log(result.a);",
        "function key(): string { return 'b'; } const result: { a: string; b?: string } = { a: 'a', ...{ [key()]: 'b' } }; console.log(result.a);",
        "const key = Symbol('b'); const result = { a: 'a', ...{ [key]: 'b' } }; console.log(result.a);",
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
fn descriptor_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "descriptor-boundary");
    for source in [
        "openSync('unused', 'rs');",
        "openSync('unused', 0);",
        "const flags = 'r'; openSync('unused', flags);",
        "openSync('unused', 'w', 0o600);",
        "openSync(new Uint8Array(1), 'r');",
        "closeSync('1');",
        "closeSync(1, 2);",
        "readSync(1, new Uint8Array(1), {offset: 0});",
        "readSync(1, new Uint8Array(1), 0, 1, 1n);",
        "readSync(1, new Uint16Array(1), 0, 1, 0);",
        "const bytes = new Uint8Array(1); console.log(bytes['0']);",
        "const bytes = new Uint8Array(1); const value: number = bytes[99]; console.log(value);",
        "function bad(bytes: Uint8Array): number { return bytes[99]; } bad(new Uint8Array(1));",
    ] {
        fs::write(
            &input,
            format!("// @ts-nocheck\nimport {{openSync, readSync, closeSync}} from 'node:fs';\n{source}\n"),
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
fn buffer_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "buffer-boundary");
    fs::write(
        &input,
        "import {Buffer} from 'node:buffer'; console.log(Buffer.alloc(1).length);",
    )
    .unwrap();
    let canary = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--emit", "ir", "--out"])
        .arg(temp.path().join("buffer-canary.json"))
        .output()
        .unwrap();
    success(&canary);
    for (source, expected) in [
        ("Buffer.alloc();", "Buffer factory overload is not ported"),
        (
            "Buffer.alloc(2, 7);",
            "Buffer factory overload is not ported",
        ),
        (
            "Buffer.allocUnsafe('2');",
            "Buffer allocation requires a represented numeric size",
        ),
        (
            "Buffer.allocUnsafe(2, 1);",
            "Buffer factory overload is not ported",
        ),
        (
            "Buffer.from(...['a']);",
            "Buffer.from iterable argument spreads are not ported",
        ),
        ("Buffer.allocUnsafeSlow(1);", "Buffer static is not ported"),
        (
            "const alloc = Buffer.allocUnsafe; alloc(1);",
            "Uint8Array property or extracted method is not ported",
        ),
        (
            "Buffer.alloc(1).buffer;",
            "Uint8Array property or extracted method is not ported",
        ),
        (
            "Buffer.allocUnsafe(1).byteOffset;",
            "Buffer pool and byteOffset observations are not ported",
        ),
        (
            "Buffer.alloc(1).toString('utf8', 1);",
            "Buffer.toString start/end overloads are not ported",
        ),
        (
            "Buffer.alloc(1).readUInt8(0);",
            "Uint8Array method/arity is not ported",
        ),
        (
            "const value = Buffer.alloc(1); value[0] = 4;",
            "indexed writes need a native dictionary",
        ),
        ("new Buffer(1);", "native subset only, no fallback"),
        (
            "const sizes = [2]; Buffer.alloc(...sizes);",
            "Buffer factory overload is not ported",
        ),
    ] {
        fs::write(
            &input,
            format!("// @ts-nocheck\nimport {{Buffer}} from 'node:buffer';\n{source}\n"),
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
            !result.status.success()
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
fn append_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "append-boundary");
    fs::write(&input, "import {appendFileSync} from 'node:fs'; appendFileSync('file', 'data', {encoding:'utf8',mode:0o600});").unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(temp.path().join("append-canary.json"))
            .output()
            .unwrap(),
    );
    for (source, expected) in [
        (
            "appendFileSync('x');",
            "appendFileSync needs path/data arguments without spreads",
        ),
        (
            "appendFileSync(1, 'x');",
            "appendFileSync needs represented string path/data and numeric mode",
        ),
        (
            "appendFileSync('x', new Uint8Array(1));",
            "appendFileSync needs represented string path/data and numeric mode",
        ),
        (
            "appendFileSync('x', 'y', 'hex');",
            "appendFileSync requires inline options or literal utf8/utf-8 encoding",
        ),
        (
            "const options = {mode: 0o600}; appendFileSync('x', 'y', options);",
            "appendFileSync requires inline options or literal utf8/utf-8 encoding",
        ),
        (
            "appendFileSync('x', 'y', {encoding:'latin1'});",
            "appendFileSync options require literal",
        ),
        (
            "appendFileSync('x', 'y', {mode:'600'});",
            "appendFileSync needs represented string path/data and numeric mode",
        ),
        (
            "appendFileSync('x', 'y', {flag:'w'});",
            "appendFileSync options require literal",
        ),
        (
            "appendFileSync('x', 'y', {flush:true});",
            "appendFileSync options require literal",
        ),
        (
            "appendFileSync('x', 'y', {get mode(){return 0o600;}});",
            "appendFileSync options require plain data properties",
        ),
        (
            "appendFileSync('x', 'y', {...{mode:0o600}});",
            "appendFileSync options require plain data properties",
        ),
        (
            "appendFileSync(...['x','y']);",
            "appendFileSync needs path/data arguments without spreads",
        ),
        (
            "appendFileSync('x', 'y', {['mo'+'de']:0o600});",
            "appendFileSync options require literal",
        ),
    ] {
        fs::write(
            &input,
            format!("// @ts-nocheck\nimport {{appendFileSync}} from 'node:fs';\n{source}\n"),
        )
        .unwrap();
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
fn read_file_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "read-file-boundary");
    fs::write(
        &input,
        "import {readFileSync} from 'node:fs'; console.log(readFileSync('file', 'utf8'));",
    )
    .unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(temp.path().join("read-file-canary.json"))
            .output()
            .unwrap(),
    );
    for (source, expected) in [
        (
            "readFileSync('x');",
            "readFileSync needs path and explicit UTF-8 encoding without spreads",
        ),
        (
            "readFileSync(1, 'utf8');",
            "readFileSync requires a represented string path",
        ),
        (
            "readFileSync('x', null);",
            "readFileSync requires literal utf8/utf-8 encoding",
        ),
        (
            "readFileSync('x', undefined);",
            "readFileSync requires literal utf8/utf-8 encoding",
        ),
        (
            "readFileSync('x', 'hex');",
            "readFileSync requires literal utf8/utf-8 encoding",
        ),
        (
            "const options={encoding:'utf8'}; readFileSync('x',options);",
            "readFileSync requires literal utf8/utf-8 encoding",
        ),
        (
            "readFileSync('x', {});",
            "readFileSync requires literal utf8/utf-8 encoding",
        ),
        (
            "readFileSync('x', {encoding:'utf8', flag:'w'});",
            "readFileSync options require literal utf8/utf-8 encoding",
        ),
        (
            "readFileSync('x', {get encoding(){return 'utf8';}});",
            "readFileSync options require plain literal encoding/flag properties",
        ),
        (
            "readFileSync('x', {...{encoding:'utf8'}});",
            "readFileSync options require plain literal encoding/flag properties",
        ),
        (
            "readFileSync(...['x','utf8']);",
            "readFileSync needs path and explicit UTF-8 encoding without spreads",
        ),
        (
            "readFileSync('x',{encoding:'utf8', ['fl'+'ag']:'r'});",
            "readFileSync options require literal utf8/utf-8 encoding",
        ),
    ] {
        fs::write(
            &input,
            format!("// @ts-nocheck\nimport {{readFileSync}} from 'node:fs';\n{source}\n"),
        )
        .unwrap();
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
fn array_spread_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "array-spread-boundary");
    fs::write(&input, "const input:number[]=[1,2]; const seen=new Set([0,...input]); console.log(seen.size,seen.has(2));").unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(temp.path().join("canary.json"))
            .output()
            .unwrap(),
    );
    for source in [
        "const input:any=[1,2]; const copy=[...input]; console.log(copy.length);",
        "const input='ab'; const copy=[...input]; console.log(copy.length);",
        "const input=new Set([1]); const copy=[...input]; console.log(copy.length);",
        "const input={0:1,length:1}; const copy=[...input]; console.log(copy.length);",
        "const input:number[]|undefined=undefined; const copy=[...input]; console.log(copy.length);",
        "const copy=[1,,...[2]]; console.log(copy.length);",
        "const input=[1,,2]; const copy=[...input]; console.log(copy.length);",
        "const input:readonly [number,...number[]]=[1,2]; const copy=[...input]; console.log(copy.length);",
        "const copy:[number,number]=[...[1,2]]; console.log(copy.length);",
        "const cb=()=>1; const input=[cb]; const seen=new Set([cb,...input]); console.log(seen.size);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
                && !stderr.contains("SCN9001")
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
fn optional_access_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "optional-access-boundary");
    fs::write(&input, "function read(d:Record<string,number>|undefined){return (d?.['x']??0)>0} console.log(read(undefined),read({x:1}));").unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(temp.path().join("canary.json"))
            .output()
            .unwrap(),
    );
    for source in [
        "const f=()=>1; console.log(f?.());",
        "const d={f(){return 1}}; console.log(d?.f());",
        "const d={f(){return 1}}; console.log(d.f?.());",
        "const a:number[]=[1]; const b:number[]=a?.map(x=>x); console.log(b);",
        "const d:Record<string,number>={}; const value:number=d?.['absent']; console.log(value);",
        "const d:Record<string,number>={}; console.log(d?.[Symbol('key')]);",
        "const d:Record<string,number>={}; console.log(d?.[{toString(){return 'x'}}]);",
        "function f(d:{a:number}|{b:number}|undefined){return d?.a} console.log(f(undefined));",
        "class Example {get x(){return 1}} const e=new Example(); console.log(e?.x);",
        "const a=[1] as const; console.log(a?.[0]);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
                && !stderr.contains("SCN9001")
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
fn tuple_includes_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "tuple-includes-boundary");
    fs::write(&input, "const a=['one','two'] as const as readonly ['one','two'] & {includes(value:string):boolean}; console.log(a.includes('one'));").unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(temp.path().join("canary.json"))
            .output()
            .unwrap(),
    );
    for source in [
        "const a=['a'] as const as readonly ['a'] & {tag:string}; console.log(a[0]);",
        "const a=['a'] as const as readonly ['a'] & {includes(value:string):string}; console.log(a[0]);",
        "const a=['a'] as const as readonly ['a'] & {includes(value:string):true}; console.log(a[0]);",
        "const a=['a'] as const as readonly ['a'] & {includes?:(value:string)=>boolean}; console.log(a[0]);",
        "const a=['a'] as const as readonly ['a'] & {includes:(value:string)=>boolean}; console.log(a[0]);",
        "const a=['a'] as const as readonly ['a'] & {includes<T>(value:T):boolean}; console.log(a[0]);",
        "const a=['a'] as const as readonly ['a'] & {[key:string]:unknown;includes(value:string):boolean}; console.log(a[0]);",
        "const a:['a'?]=['a']; console.log(a.includes('a'));",
        "const a:readonly ['a', ...string[]]=['a','b']; console.log(a.includes('a'));",
        "const a=['a'] as const; const includes=a.includes; console.log(includes('a'));",
        "const a=[{value:1}] as const; console.log(a.includes(a[0]));",
        "const a=[1] as const; console.log(a.includes(1, {valueOf(){return 0}}));",
        "const a=[1] as const; console.log(a.includes(...[1]));",
        "const a=['a'] as const; const alias = a as readonly string[]; console.log(alias.includes('a'));",
        "function f(a: readonly ['a'] | undefined) { return (a! as readonly string[]).includes('a'); } console.log(f(undefined));",
        "const a=['a'] as const as ['a'] & {includes(value:string):boolean}; console.log(a[0]);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
                && !stderr.contains("SCN9001")
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
fn zlib_unimplemented_options_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "zlib-boundary");
    for source in [
        "const level=1; deflateSync(new Uint8Array([1]), {level});",
        "deflateSync(new Uint8Array([1]), {level: 10});",
        "deflateSync(new Uint8Array([1]), {level: 1, strategy: 1});",
        "inflateSync(new Uint8Array([1]), {finishFlush: 2});",
        "deflateSync(new Uint8Array([1]), ...[{}]);",
    ] {
        fs::write(
            &input,
            format!(
                "// @ts-nocheck\nimport {{deflateSync,inflateSync}} from 'node:zlib'; {source}\n"
            ),
        )
        .unwrap();
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
fn array_reduce_unimplemented_overloads_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "reduce-boundary");
    for source in [
        "[1,2].reduce((a,b) => a+String(b), '');",
        "['a','b'].reduce((a,b) => a+b);",
        "[1,2].reduce(...[(a,b) => a+b, 0]);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler()).arg("build").arg(&input)
            .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn typed_array_tuple_set_rejects_unrepresented_sources() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "tuple-set-boundary");
    for source in [
        "const source: [number?] = []; new Uint8Array(2).set(source);",
        "const source: [number, string] = [1, 'x']; new Uint8Array(2).set(source);",
        "const source: [number, number] = [1,2]; new Uint8Array(3).set(...[source, 0]);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] {
            fs::write(artifact, "preserve").unwrap();
        }
        let output = Command::new(compiler()).arg("build").arg(&input)
            .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn numeric_dictionary_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "numeric-dictionary-boundary");
    fs::write(
        &input,
        "const d: Record<number,string>={2:'two'}; console.log(String(d[2]));",
    )
    .unwrap();
    success(
        &Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(temp.path().join("numeric-dictionary-canary.json"))
            .output()
            .unwrap(),
    );
    for (source, expected) in [
        (
            "interface Mixed {[key:number]:string; label:string} const d:Mixed={2:'two',label:'name'}; console.log(d.label);",
            "type has no representation",
        ),
        (
            "interface Mixed {[key:string]:string|number;[key:number]:string} const d:Mixed={2:'two'}; console.log(d[2]);",
            "type has no representation",
        ),
        (
            "const d:Record<symbol,string>={}; console.log(d);",
            "type has no representation",
        ),
        (
            "const d:Record<number,()=>number>={2:()=>2}; console.log(d);",
            "type has no representation",
        ),
        (
            "const d:Record<number,string>={}; const value:string=d[99]; console.log(value);",
            "native representation coercion is not ported",
        ),
        (
            "const d:Record<number,string>={}; const key={toString(){return '2';}}; console.log(d[key]);",
            "native representation coercion is not ported",
        ),
        (
            "const d:Record<number,string>={}; console.log(d[Symbol('key')]);",
            "native representation coercion is not ported",
        ),
        (
            "const d:Record<number,string>={}; console.log(d[2], 'value');",
            "Node console format substitution is not ported",
        ),
        (
            "console.log('object', {value:1});",
            "non-primitive console argument values are not ported",
        ),
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
        if expected == "native representation coercion is not ported" {
            assert!(
                stderr.contains(" -> "),
                "missing coercion layouts: {stderr}"
            );
        }
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
    fs::write(
        &input,
        "const set = new Set<unknown>(['a', ...['b']]); console.log(set.size, set.has('b'));",
    )
    .unwrap();
    let expected = Command::new(oracle()).arg(&input).output().unwrap();
    success(&expected);
    let built = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&built);
    let actual = Command::new(&target).output().unwrap();
    success(&actual);
    assert_eq!(actual.stdout, expected.stdout);
    assert_eq!(actual.stderr, expected.stderr);
    for source in [
        "const set = new Set<unknown>(['a', ...new Set(['b'])]);",
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
    let input = temp
        .path()
        .join("source # % cafÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©.mts");
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
        ("Buffer", "byteLength", "native-partial"),
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
            "(255).toString({ valueOf: (): number => 16 } as any);",
            "standard numeric arguments require represented primitives",
        ),
        (
            "('7' as unknown as number).toString();",
            "Number formatting requires a represented numeric receiver",
        ),
        (
            "(255).toString(...[16]);",
            "Number formatting iterable argument spreads are not ported",
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
            "const values = [1]; Number(...values);",
            "iterable call spreads are not ported",
        ),
        (
            "const C = Number; C.isFinite(1);",
            "standard constructor properties require their native member adapter",
        ),
        (
            "const C = Number; console.log(C['MAX_VALUE']);",
            "standard constructor properties require their native member adapter",
        ),
        (
            "'x'.repeat({ valueOf: () => 1 } as any);",
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
const high = "ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¹Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬".slice(0, 1);
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

#[test]
fn process_write_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "process-write-boundary");
    for source in [
        "import p from 'node:process'; const result = p.stderr.write('x');",
        "import p from 'node:process'; console.log(p.stdout.write('x'));",
        "import p from 'node:process'; const f = () => p.stderr.write('x'); f();",
        "import p from 'node:process'; function f(): boolean { return p.stderr.write('x'); } f();",
        "import p from 'node:process'; p.stderr.write('x', 'utf8');",
        "import p from 'node:process'; p.stderr.write('x', () => {});",
        "import p from 'node:process'; p.stdout.write(new Uint8Array([65]));",
        "import p from 'node:process'; p.stdout.write(42);",
        "import p from 'node:process'; p.stdout.write(...['x']);",
        "import p from 'node:process'; const stream = p.stderr; stream.write('x');",
        "import p from 'node:process'; const write = p.stderr.write; write('x');",
        "import p from 'node:process'; p.stderr.write = (text: string) => true;",
        "import p from 'node:process'; p.stderr?.write('x');",
        "import p from 'node:process'; p.stderrWrite('x');",
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
fn relational_erased_object_coercion_fails_explicitly() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    fs::write(&input, r#"// @ts-nocheck
const value: unknown = { n: 1 };
try { console.log(value < 2); }
catch (error) { if (error instanceof Error) console.log('boundary', error.message); else throw error; }
"#).unwrap();
    let target = binary(temp.path(), "relational-object-boundary");
    let built = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&built);
    let actual = Command::new(&target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .output()
        .unwrap();
    success(&actual);
    assert_eq!(
        String::from_utf8(actual.stdout).unwrap().trim(),
        "boundary scriptc: relational object coercion requires native ToPrimitive support"
    );
    assert!(actual.stderr.is_empty());
}

#[test]
fn array_pop_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let config_path = temp.path().join("tsconfig.json");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["compilerOptions"]["allowJs"] = serde_json::json!(true);
    fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let target = binary(temp.path(), "array-pop-boundary");
    for (extension, source) in [
        (
            "mts",
            "function f(values: number[] | null): void { values.pop(); } f(null);",
        ),
        (
            "mts",
            "const values: (string | number)[] = ['a']; values.pop();",
        ),
        ("mts", "const values: unknown[] = [1]; values.pop();"),
        ("mts", "const values: number[] = [1]; values.pop(...[1]);"),
        (
            "mts",
            "const values: number[] = [1]; const required: number = values.pop(); console.log(required);",
        ),
        ("mts", "const values = [1, 2] as const; values.pop();"),
        (
            "mts",
            "const box: { values: number[] | null } = { values: [1] }; const clear = () => { box.values = null; }; if (box.values !== null) { clear(); box.values.pop(); }",
        ),
    ] {
        let input = temp.path().join(format!("main.{extension}"));
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
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
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
        fs::remove_file(input).unwrap();
    }
}

#[test]
fn inferred_record_array_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let config_path = temp.path().join("tsconfig.json");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["compilerOptions"]["allowJs"] = serde_json::json!(true);
    fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let target = binary(temp.path(), "inferred-record-boundary");
    for (extension, source) in [
        (
            "mts",
            "const rows: { key: string }[] = [{ key: 'a' }]; rows.push({ key: undefined });",
        ),
        (
            "mjs",
            "/** @type {{key: string}[]} */ const rows = [{ key: 'a' }]; rows.push({ key: undefined });",
        ),
        ("mjs", "const rows = [{ key: () => 1 }]; rows.push({});"),
        (
            "mjs",
            "const rows = [{ key: 'a' }]; let alias = rows; alias.push({ key: undefined });",
        ),
        (
            "mjs",
            "const rows = [{ key: 'a' }]; const name = 'key'; rows.push({ [name]: undefined });",
        ),
        (
            "mjs",
            "const rows = [{ key: 'a' }]; rows.push({ key: undefined }); /** @param {{key: string}} row */ const read = (row) => console.log(row.key); read(rows[1]);",
        ),
    ] {
        let input = temp.path().join(format!("main.{extension}"));
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
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
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
        fs::remove_file(input).unwrap();
    }
}

#[test]
fn erased_rest_entry_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    fs::write(temp.path().join("package.json"), r#"{"type":"module"}"#).unwrap();
    let package = temp.path().join("node_modules/rest-entry");
    fs::create_dir_all(&package).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"name":"rest-entry","type":"module","main":"index.js","types":"index.d.ts"}"#,
    )
    .unwrap();
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "erased-rest-entry-boundary");
    for (declaration, implementation, caller) in [
        (
            "export const f: (...args: any[]) => any;",
            "export const f = ([value]) => value;",
            "import { f } from 'rest-entry'; f([1]);",
        ),
        (
            "export const f: (...args: number[]) => number;",
            "export const f = (a, b) => a + b;",
            "import { f } from 'rest-entry'; f(1, 2);",
        ),
        (
            "export const f: (...args: any[]) => any;",
            "export const f = (first, ...tail) => first;",
            "import { f } from 'rest-entry'; f(1, 2);",
        ),
        (
            "export const f: (...args: any[]) => any;",
            "export const f = function () { return arguments.length; };",
            "import { f } from 'rest-entry'; f(1);",
        ),
        (
            "export const f: (...args: any[]) => any;",
            "export const f = (a = a) => a;",
            "import { f } from 'rest-entry'; f();",
        ),
        (
            "export const f: (...args: any[]) => any;",
            "export const f = (a = b, b = 1) => a;",
            "import { f } from 'rest-entry'; f();",
        ),
        (
            "export const f: (...args: any[]) => any;",
            "export const f = () => 1;",
            "// @ts-nocheck\nconst f: (...args: any[]) => any = (a: any, b: any) => a; f(1, 2);",
        ),
    ] {
        fs::write(package.join("index.d.ts"), declaration).unwrap();
        fs::write(package.join("index.js"), implementation).unwrap();
        fs::write(&input, caller).unwrap();
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
            "{implementation}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn string_identity_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "string-identity-boundary");
    for source in [
        "const read = 'x'.toString; read();",
        "'x'.toString.call('y');",
        "'x'.toString.apply('y', []);",
        "function f(value: string | null): string { return value.toString(); } f(null);",
        "'x'.toString(...[1]);",
        "'x'.valueOf(...[1]);",
        "new String('x').toString();",
        "export {}; declare global { interface String { toString(): string; } } 'x'.toString();",
        "export {}; declare global { interface String { valueOf(): string; } } 'x'.valueOf();",
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
fn bigint_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let config_path = temp.path().join("tsconfig.json");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["compilerOptions"]["allowJs"] = serde_json::json!(true);
    fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let target = binary(temp.path(), "bigint-boundary");
    for (extension, source) in [
        (
            "mts",
            "function f(value: any): bigint { return BigInt(value); } f('1');",
        ),
        ("mts", "BigInt({ valueOf: () => 1 });"),
        ("mts", "const ctor = BigInt; ctor('1');"),
        ("mts", "BigInt(...['1']);"),
        ("mts", "console.log(1n + 1);"),
        ("mts", "new BigInt(1);"),
        ("mts", "console.log(1n >>> 1n);"),
    ] {
        let input = temp.path().join(format!("main.{extension}"));
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
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
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
        fs::remove_file(input).unwrap();
    }
}

#[test]
fn javascript_parameter_abi_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let config_path = temp.path().join("tsconfig.json");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["compilerOptions"]["allowJs"] = serde_json::json!(true);
    fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let target = binary(temp.path(), "javascript-parameter-boundary");
    for (extension, source) in [
        (
            "mts",
            "const f = (key: string): void => { console.log(key); }; f(undefined);",
        ),
        (
            "mjs",
            "/** @param {string} key @returns {string} */ function f(key) { return key; } f(undefined);",
        ),
        (
            "mjs",
            "/** @type {(key: string) => void} */ const f = (key) => console.log(key); f(undefined);",
        ),
        (
            "mjs",
            "/** @param {string} key */ const f = (key) => console.log(key.trim()); f(undefined);",
        ),
    ] {
        let input = temp.path().join(format!("main.{extension}"));
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
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
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
        fs::remove_file(input).unwrap();
    }
}

#[test]
fn array_length_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "array-length-boundary");
    for source in [
        "function f(x: number[] | string): number { return x.length; } f('a');",
        "function f(x: { length: number } | null): number { return x.length; } f(null);",
        "function f(x: number[] | null): number { const key = () => 'length'; return x[key()]; } f(null);",
        "function f(x: number[] | null): void { x.length = 0; } f(null);",
        "function f(x: number[] | null): void { x.push(1); } f(null);",
        "function f(x: number[] | null): number | undefined { return x?.length; } f(null);",
        "function f(x: number[] | null): void { x.length(); } f(null);",
        "function f(x: string[] | null): void { const value: string = x[0]; console.log(value); } f(null);",
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
fn relational_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "relational-boundary");
    for source in [
        "console.log({ valueOf: () => 1 } < 2);",
        "console.log(2 < { toString: () => '3' });",
        "console.log([1] < 2);",
        "console.log(Object(1n) < 2n);",
        "console.log(({ valueOf: () => 1 } as number) < 2);",
        "console.log(2 < ({} as unknown as number));",
        "console.log(Symbol('x') + 1);",
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
fn update_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "update-boundary");
    for source in [
        "const n = 1; n++;",
        "let n: unknown = 1; n++;",
        "let n = { valueOf: () => 1 }; n++;",
        "let n = 1n; n++;",
        "const a = [1]; a[0]++;",
        "const d: Record<string, number> = { a: 1 }; d.a++;",
        "const r = { a: 1 }; const k = () => 'a'; r[k()]++;",
        "const r: { a: number } | undefined = { a: 1 }; r?.a++;",
        "class C { n = 1; } const c = new C(); c.n++;",
        "class C { get n(): number { return 1; } set n(x: number) {} } const c = new C(); c.n++;",
        "class C { #n = 1; f(): number { return this.#n++; } } new C().f();",
        "const r = { a: 1 }; r.__proto__++;",
        "enum E { A = 1 } E.A++;",
        "let n = '1'; n++;",
        "let n: string | number = '1'; n++;",
        "let n: boolean | number = false; n++;",
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
fn compound_assignment_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "compound-boundary");
    for source in [
        "const n = 1; n += 2;",
        "let n = 1; n += 'x';",
        "let n = 'a'; n += 1;",
        "let n = 'a'; n -= 1;",
        "const r = { n: 1 }; r.n += 2;",
        "const a = [1]; a[0] += 2;",
        "const d: Record<string, number> = { n: 1 }; d.n += 2;",
        "class C { #n = 1; f(): void { this.#n += 2; } } new C().f();",
        "enum E { A = 1 } E.A += 1;",
        "let n=1; const rhs:any='x'; n += rhs;",
        "const r={n:1}; r.n |= 2;",
        "const a=[1]; a[0] <<= 2;",
        "const r={valueOf:()=>1}; console.log(r | 2);",
        "const r={valueOf:()=>1}; console.log(~r);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
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
fn loop_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "loop-boundary");
    for source in [
        "outer: while (true) { break outer; }",
        "outer: while (true) { continue outer; }",
        "break;",
        "continue;",
        "while (true) { const f = () => { break; }; f(); break; }",
        "while (true) { const f = () => { continue; }; f(); break; }",
        "do { break; } while (false);",
        "while (true) { switch (1) { case 1: break; } break; }",
        "function f(): number { while (true) { try { return 1; } finally { break; } } } f();",
        "while (true) { const f = () => value; let value = 1; f(); break; }",
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
fn weak_set_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "weak-set-boundary");
    for source in [
        "const C = WeakSet; new C([{ x: 1 }]);",
        "class Child extends WeakSet<object> {} new Child();",
        "const s = new WeakSet<object>(); const add = s.add;",
        "const s: unknown = new WeakSet<object>();",
        "const s: unknown = { nested: new WeakSet<object>() };",
        "const s = new WeakSet<object>(); s.add(...[{ x: 1 }]);",
        "new WeakSet<object>(...[[{ x: 1 }]]);",
        "new WeakSet<object>(new Set<object>());",
        "new WeakSet<object>('keys');",
        "const s = new WeakSet<object>(); s.add([]);",
        "const s = new WeakSet<object>(); s.add(() => 1);",
        "const s = new WeakSet<object>(); s.add(Symbol('key'));",
        "new WeakSet([Symbol('key')]);",
        "class Key { x = 1; } new WeakSet<object>().add(new Key());",
        "const s = new WeakSet<object>(); s.add(s);",
        "const s = new WeakSet<object>(); console.log(s.size);",
        "const s = new WeakSet<object>(); s.add = () => s;",
        "const s = new WeakSet<object>(); console.log(s['[[WeakSetData]]']);",
        "Object.keys(new WeakSet<object>());",
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
fn object_keys_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "keys-boundary");
    for source in [
        "Object.keys(...[{ x: 1 }]);",
        "const keys = Object.keys; keys({ x: 1 });",
        "class C { x = 1; } Object.keys(new C());",
        "Object.keys(new String('one'));",
        "Object.keys(new Map<string, number>());",
        "Object.keys(new Set<string>());",
        "Object.keys(function f() { return 1; });",
        "Object.keys({ get x() { return 1; } });",
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
fn boxed_primitive_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "boxed-boundary");
    for source in [
        "const C = Number; new C(1);",
        "new Number({ valueOf() { return 1; } });",
        "new String({ toString() { return 'one'; } });",
        "new String(Symbol('one'));",
        "new Number(...[1]);",
        "class Child extends Number {} new Child(1);",
        "const value = new String('one'); console.log(value.length);",
        "const value = new String('one'); console.log(value['0']);",
        "const value = new Number(1); value.toString();",
        "Number.prototype.valueOf.call(1);",
        "const value = new Number(1); value?.valueOf();",
        "const value = new Number(1); console.log(value['unknown']);",
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
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success()
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
fn regex_replacement_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "regex-replacement-boundary");
    for source in [
        "'x'.replace(/x/, (text: string): string => text);",
        "'x'.replaceAll(/x/g, { toString(): string { return 'y'; } });",
        "'x'.replace(/x/, Symbol('replacement'));",
        "function f(re: RegExp | undefined): string { return 'x'.replace(re, 'y'); } f(undefined);",
        "'x'.replace(...[/x/, 'y']);",
        "const method = 'x'.replace; method(/x/, 'y');",
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
fn function_source_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "function-source-boundary");
    for source in [
        "function f(): number { return 1; } f.toString();",
        "let parse = JSON.parse; parse.toString();",
        "const parse: typeof JSON.parse = () => null; parse.toString();",
        "const bound = JSON.parse.bind(null); bound.toString();",
        "JSON.parse.toString(...[1]);",
        "const source = JSON.parse.toString; source();",
        "JSON.parse.toString.call(JSON.stringify);",
        "export {}; declare global { interface Function { toString(): string; } } JSON.parse.toString();",
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
fn aggregate_slots_use_owning_ir_storage() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = temp.path().join("slots.ir.json");
    fs::write(&input, "const factory = () => ({ children: [], key: undefined, nil: null }); const value = factory(); console.log('slots', value.children.length, value.key === undefined, value.nil === null);").unwrap();
    let output = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--emit", "ir", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    success(&output);
    let module: serde_json::Value = serde_json::from_slice(&fs::read(target).unwrap()).unwrap();
    assert_eq!(module["irVersion"], 13);
    let record = module["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| {
            let fields = record["fields"].as_array().unwrap();
            fields.len() == 3 && fields.iter().any(|field| field["name"] == "children")
        })
        .unwrap();
    for field in record["fields"].as_array().unwrap() {
        if field["name"] == "children" {
            assert_eq!(field["type"]["kind"], "array");
            assert_eq!(field["type"]["elem"]["kind"], "dyn");
        } else {
            assert_eq!(field["type"]["kind"], "dyn");
        }
    }
}

#[test]
fn optional_record_view_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "optional-view-boundary");
    let join =
        fs::read_to_string(root().join("tests/fixtures/native-unrefined-array-join.ts")).unwrap();
    for source in [
        "function bad(value: {}): { width: number } { return value as unknown as { width: number }; } console.log(bad({}).width);",
        "function bad(value: { width: number }): { width?: number } { return value; } console.log(bad({width: 1}).width === 1);",
        "function bad(value: { width: number }): { width: number; height?: number } | { width: number; depth?: number } { return value; } console.log(Object.keys(bad({width: 1})).join('|'));",
        join.as_str(),
    ] {
        fs::write(&input, source).unwrap();
        let artifacts = [
            target.clone(),
            target.with_extension("rs"),
            target.with_extension("ir.json"),
        ];
        for path in &artifacts {
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
        if source == join {
            assert!(
                stderr.contains("array.join requires a represented array or fixed tuple receiver"),
                "{stderr}"
            );
        }
        for path in artifacts {
            assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
        }
    }
}

#[test]
fn replacement_callback_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "replacement-boundary");
    for source in [
        "'a'.replace(/a/, { toString() { return 'x'; } });",
        "const callback: any = () => 'x'; 'a'.replace(/a/, callback);",
        "'a'.replace('a', () => 'x');",
        "'a'.replace(/a/, ...[() => 'x']);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        let artifacts = [
            target.clone(),
            target.with_extension("rs"),
            target.with_extension("ir.json"),
        ];
        for path in &artifacts {
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
fn object_parameter_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "object-parameter-boundary");
    for source in [
        "function f({a: {b}}: {a: {b: number}}): number { return b; } console.log(f({a: {b: 1}}));",
        "const key = 'a'; function f({[key]: a}: {a: number}): number { return a; } console.log(f({a: 1}));",
        "function f([a]: number[]): number { return a; } console.log(f([1]));",
        "function f({length}: string): number { return length; } console.log(f('a'));",
        "function f({value}: {value: number} | null): number { return value; } console.log(f({value: 1}));",
        "const value = 9; function f({value = value}: {value?: number}): number { return value; } console.log(f({}));",
        "function f({first = later, later = 1}: {first?: number; later?: number}): number { return first; } console.log(f({}));",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        let artifacts = [
            target.clone(),
            target.with_extension("rs"),
            target.with_extension("ir.json"),
        ];
        for path in &artifacts {
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
fn function_property_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "function-property-boundary");
    for source in [
        "function f(): number { return 1; } f.name = 'new'; console.log(f());",
        "function f(): number { return 1; } delete f['prototype']; console.log(f());",
        "function f(): number { return 1; } f[Symbol('key')] = 1; console.log(f());",
        "function f(): number { return 1; } const key = {toString() {return 'label';}}; f[key] = 1; console.log(f());",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}")).unwrap();
        let artifacts = [
            target.clone(),
            target.with_extension("rs"),
            target.with_extension("ir.json"),
        ];
        for path in &artifacts {
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
fn public_declaration_abi_preserves_execution_storage() {
    let temp = tempfile::tempdir().unwrap();
    for fixture in ["nominal", "containers"] {
        let input = root().join(format!(
            "tests/corpus/rust-native-declaration-abi/{fixture}.ts"
        ));
        let target = temp.path().join(format!("{fixture}.json"));
        let output = Command::new(compiler())
            .arg("build")
            .arg(input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        success(&output);
        let module: serde_json::Value = serde_json::from_slice(&fs::read(target).unwrap()).unwrap();
        let globals = module["globals"].as_array().unwrap();
        let global = |name: &str| {
            globals
                .iter()
                .find(|global| global["name"] == name)
                .unwrap()
        };
        if fixture == "nominal" {
            assert_eq!(global("client")["type"]["kind"], "object");
            assert_eq!(global("alias")["type"]["kind"], "dyn");
            assert_eq!(global("clients")["type"]["kind"], "array");
            assert_eq!(global("clients")["type"]["elem"]["kind"], "object");
            assert_eq!(global("call")["type"]["kind"], "func");
            assert_eq!(global("call")["type"]["params"][0]["kind"], "object");
        } else {
            assert_eq!(global("values")["type"]["kind"], "array");
            assert_eq!(global("values")["type"]["elem"]["kind"], "f64");
            assert_eq!(global("pair")["type"]["kind"], "record");
            assert!(
                module["functions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|function| {
                        function["params"][0]["name"] == "values"
                            && function["params"][0]["type"]["kind"] == "array"
                            && function["params"][0]["type"]["elem"]["kind"] == "f64"
                    })
            );
        }
    }
}

#[test]
fn public_declaration_constructor_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    fs::write(temp.path().join("api.d.ts"), "export declare class Client { value: number; constructor(); } export declare function construct(value: typeof Client): Client;").unwrap();
    fs::write(temp.path().join("api.js"), "export class Client { constructor() { this.value = 1; } } export function construct(value) { return new value(); }").unwrap();
    let input = temp.path().join("main.ts");
    fs::write(
        &input,
        "import { Client, construct } from './api.js'; console.log(construct(Client).value);",
    )
    .unwrap();
    let target = binary(temp.path(), "constructor-abi-boundary");
    let artifacts = [
        target.clone(),
        target.with_extension("rs"),
        target.with_extension("ir.json"),
    ];
    for path in &artifacts {
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
        "{stderr}"
    );
    for path in artifacts {
        assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
    }
}

#[test]
fn array_sequence_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "array-sequence-boundary");
    for source in [
        "[1].some();",
        "[1].some(1);",
        "[1].some(...[() => true]);",
        "[1].every();",
        "[1].every(1);",
        "[1].every(...[() => true]);",
        "[1].slice({ valueOf() { return 0; } });",
        "function f(value: number[] | undefined) { return value!.slice(); } f(undefined);",
        "function f(value: number[] | undefined) { return value!.some(() => true); } f(undefined);",
        "function f(value: number[] | undefined) { return value!.every(() => true); } f(undefined);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            target.clone(),
            target.with_extension("rs"),
            target.with_extension("ir.json"),
        ];
        for path in &artifacts {
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
fn regexp_method_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    for source in [
        "const regex = /a/; regex.test = () => false; console.log(regex.test('a'));",
        "const regex = /a/; regex.exec = () => null; console.log(regex.test('a'));",
        "const regex = /a/; const exec = regex.exec; console.log(exec('a'));",
        "const row = /(?<value>a)/.exec('a'); if (row !== null) console.log(row.groups);",
        "const row = /a/.exec('a'); if (row !== null) console.log(row.indices);",
        "const regex = /a/; regex.exec();",
        "const regex = /a/; regex.exec('a', 'extra');",
        "const row = /a/.exec('a'); const key: string = 'index'; if (row !== null) console.log(row[key]);",
    ] {
        let input = temp.path().join("main.ts");
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let target = binary(temp.path(), "regexp-method-boundary");
        let artifacts = [
            target.clone(),
            target.with_extension("rs"),
            target.with_extension("ir.json"),
        ];
        for path in &artifacts {
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
fn survey_collects_independent_failures_without_external_tools() {
    let temp = tempfile::tempdir().unwrap();
    let fixtures = root().join("tests/fixtures/native-survey");
    let paths = [
        "manifest.json",
        "tsconfig.json",
        "supported.ts",
        "regex.ts",
        "write.ts",
    ];
    let originals = paths.map(|path| fs::read(fixtures.join(path)).unwrap());
    let traps = temp.path().join("traps");
    fs::create_dir(&traps).unwrap();
    let source = temp.path().join("trap.rs");
    fs::write(&source, "fn main() { std::fs::write(std::env::var(\"SCRIPTC_FORBIDDEN_MARKER\").unwrap(), b\"called\").unwrap(); std::process::exit(99); }").unwrap();
    let trap = binary(temp.path(), "trap");
    success(
        &Command::new("rustc")
            .arg(&source)
            .arg("-o")
            .arg(&trap)
            .output()
            .unwrap(),
    );
    for name in ["node", "go", "tsgo", "tsc", "bun", "cargo", "rustc"] {
        fs::copy(&trap, binary(&traps, name)).unwrap();
    }
    let path = std::env::join_paths(
        std::iter::once(traps).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let marker = temp.path().join("forbidden-called");
    let target = temp.path().join("survey results.json");
    let run = |manifest: &Path| {
        Command::new(compiler())
            .arg("survey")
            .arg(manifest)
            .arg("--out")
            .arg(&target)
            .env("PATH", &path)
            .env("SCRIPTC_FORBIDDEN_MARKER", &marker)
            .output()
            .unwrap()
    };
    let output = run(&fixtures.join("manifest.json"));
    assert!(
        !output.status.success(),
        "blocked probes must not report success"
    );
    let report: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(report["kind"], "native-survey");
    assert_eq!(report["jobs"], 1);
    assert_eq!(report["engine"], "none");
    assert_eq!(report["fallback"], false);
    assert_eq!(report["irAccepted"], 1);
    assert_eq!(report["blocked"], 3);
    assert_eq!(report["toolFailures"], 0);
    assert_eq!(report["timedOut"], 0);
    assert_eq!(report["diagnosticOrigins"]["none"], 1);
    assert_eq!(report["diagnosticOrigins"]["native-refusal"], 3);
    assert_eq!(
        report["probes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["supported", "regex", "write", "regex-alias"]
    );
    let families = report["families"].as_array().unwrap();
    assert_eq!(families.len(), 2);
    assert_eq!(
        families[0]["occurrences"][0]["roots"],
        serde_json::json!(["regex", "regex-alias"])
    );
    assert_eq!(families[0]["occurrences"].as_array().unwrap().len(), 1);
    assert!(!marker.exists());
    assert!(!target.with_extension("rs").exists());
    assert!(!target.with_extension("ir.json").exists());
    // A reversed queue produces the same stable diagnostic families.
    let reversed = temp.path().join("reversed.json");
    fs::write(&reversed, serde_json::to_vec(&serde_json::json!({"entries": [
        {"name":"regex-alias","input":fixtures.join("regex.ts"),"project":fixtures.join("tsconfig.json")},
        {"name":"write","input":fixtures.join("write.ts"),"project":fixtures.join("tsconfig.json")},
        {"name":"regex","input":fixtures.join("regex.ts"),"project":fixtures.join("tsconfig.json")},
        {"name":"supported","input":fixtures.join("supported.ts"),"project":fixtures.join("tsconfig.json")}
    ]})).unwrap()).unwrap();
    assert!(!run(&reversed).status.success());
    let repeated: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(repeated["families"], report["families"]);
    assert!(!marker.exists());
    for (index, path) in paths.iter().enumerate() {
        assert_eq!(fs::read(fixtures.join(path)).unwrap(), originals[index]);
    }
}

#[test]
fn frontend_phase_tracing_is_opt_in_and_keeps_ir_output() {
    let temp = tempfile::tempdir().unwrap();
    let input = root().join("tests/fixtures/native-survey/supported.ts");
    let project = root().join("tests/fixtures/native-survey/tsconfig.json");
    let run = |name: &str, trace: bool| {
        let mut command = Command::new(compiler());
        command.arg("build").arg(&input).arg("--project").arg(&project)
            .args(["--emit", "ir", "--out"]).arg(temp.path().join(name))
            .env_remove("SCRIPTC_TRACE_PHASES");
        if trace { command.env("SCRIPTC_TRACE_PHASES", "1"); }
        command.output().unwrap()
    };
    let quiet = run("quiet.json", false);
    let traced = run("traced.json", true);
    success(&quiet);
    success(&traced);
    assert!(quiet.stderr.is_empty());
    let stderr = String::from_utf8_lossy(&traced.stderr);
    for phase in ["frontend project load", "frontend binding", "frontend type checking", "frontend execution view", "frontend declaration snapshot", "frontend module planning", "frontend inventories"] {
        assert!(stderr.contains(&format!("scriptc: {phase} started")), "missing {phase}: {stderr}");
    }
    assert_eq!(fs::read(temp.path().join("quiet.json")).unwrap(), fs::read(temp.path().join("traced.json")).unwrap());
}

#[test]
fn survey_reports_module_resolution_separately_from_native_refusals() {
    let temp = tempfile::tempdir().unwrap();
    let fixtures = root().join("tests/fixtures/native-survey");
    let source = temp.path().join("missing-module.ts");
    let project = temp.path().join("tsconfig.json");
    let manifest = temp.path().join("manifest.json");
    let report = temp.path().join("report.json");
    fs::copy(fixtures.join("tsconfig.json"), &project).unwrap();
    fs::write(
        &source,
        "import { value } from './not-installed.js'; console.log(value);\n",
    )
    .unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({"entries": [
            {"name":"missing-module","input":source,"project":project}
        ]}))
        .unwrap(),
    )
    .unwrap();
    let output = Command::new(compiler())
        .arg("survey")
        .arg(&manifest)
        .arg("--out")
        .arg(&report)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&fs::read(report).unwrap()).unwrap();
    assert_eq!(value["blocked"], 1);
    assert_eq!(value["probes"][0]["diagnosticOrigin"], "module-resolution");
    assert_eq!(value["diagnosticOrigins"]["module-resolution"], 1);
    assert!(
        value["probes"][0]["stderr"]
            .as_str()
            .unwrap()
            .contains("error TS2307:")
    );
}

#[test]
fn survey_distinguishes_unused_exports_from_explicit_demands() {
    let temp = tempfile::tempdir().unwrap();
    let fixtures = root().join("tests/fixtures/native-survey");
    let manifest = temp.path().join("manifest.json");
    fs::write(&manifest, serde_json::to_vec(&serde_json::json!({"entries": [
        {"name":"dormant","input":fixtures.join("dormant.ts"),"project":fixtures.join("tsconfig.json")},
        {"name":"demanded","input":fixtures.join("demand.ts"),"project":fixtures.join("tsconfig.json"),"scope":"demand-adapter"}
    ]})).unwrap()).unwrap();
    let target = temp.path().join("report.json");
    let output = Command::new(compiler())
        .arg("survey")
        .arg(&manifest)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(report["probes"][0]["status"], "ir-accepted");
    assert_eq!(report["probes"][1]["status"], "blocked");
    assert_eq!(report["probes"][1]["scope"], "demand-adapter");
    assert!(
        report["scope"]
            .as_str()
            .unwrap()
            .contains("Unused exported bodies")
    );
}

#[test]
fn survey_invalid_requests_preserve_existing_files() {
    let temp = tempfile::tempdir().unwrap();
    let fixtures = root().join("tests/fixtures/native-survey");
    let manifest = fixtures.join("manifest.json");
    let target = temp.path().join("report.json");
    fs::write(&target, "preserve").unwrap();
    for option in [["--jobs", "0"], ["--jobs", "4"], ["--timeout-seconds", "0"]] {
        let output = Command::new(compiler())
            .arg("survey")
            .arg(&manifest)
            .args(option)
            .arg("--out")
            .arg(&target)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("SCN0001"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "preserve");
    }
    for protected in [
        fixtures.join("dormant.ts"),
        fixtures.join("tsconfig.json"),
        manifest.clone(),
        target,
    ] {
        let original = fs::read(&protected).unwrap();
        let output = Command::new(compiler())
            .arg("survey")
            .arg(&manifest)
            .arg("--out")
            .arg(&protected)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("SCN0001"));
        assert_eq!(fs::read(&protected).unwrap(), original);
    }
}

#[test]
fn survey_keeps_other_entries_when_one_source_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let fixtures = root().join("tests/fixtures/native-survey");
    let manifest = temp.path().join("manifest.json");
    fs::write(&manifest, serde_json::to_vec(&serde_json::json!({"entries": [
        {"name":"missing","input":"missing.ts"},
        {"name":"supported","input":fixtures.join("supported.ts"),"project":fixtures.join("tsconfig.json")}
    ]})).unwrap()).unwrap();
    let target = temp.path().join("report.json");
    let output = Command::new(compiler())
        .arg("survey")
        .arg(&manifest)
        .arg("--out")
        .arg(&target)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(report["toolFailures"], 1);
    assert_eq!(report["irAccepted"], 1);
    assert_eq!(report["probes"][0]["status"], "tool-failure");
    assert_eq!(report["probes"][1]["status"], "ir-accepted");
}

#[test]
fn object_storage_preserves_contextual_and_published_contracts() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("contracts.ir.json");
    let output = Command::new(compiler())
        .arg("build")
        .arg(root().join("tests/corpus/rust-native-object-storage/contracts.ts"))
        .args(["--no-engine", "--emit", "ir", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let module: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    let global = |name: &str| {
        module["globals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["name"] == name)
            .unwrap()
    };
    assert_eq!(global("store")["type"]["kind"], "dyn");
    for name in ["fixed", "typed"] {
        assert_eq!(global(name)["type"]["kind"], "record", "{name}");
    }
    for (extension, source) in [
        ("ts", "// @ts-nocheck\nconst value = {}; value.extra = 1;"),
        (
            "mjs",
            "// @ts-nocheck\n/** @type {{known?: number}} */ const value = {}; value.extra = 1;",
        ),
    ] {
        let input = temp.path().join(format!("context.{extension}"));
        fs::write(&input, source).unwrap();
        let previous = fs::read(&target).unwrap();
        let output = Command::new(compiler())
            .arg("build")
            .arg(&input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "contextual contract was erased: {source}"
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("SCN1001"));
        assert_eq!(fs::read(&target).unwrap(), previous);
    }
}

#[test]
fn numeric_parser_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "numeric-parser-boundary");
    for source in [
        "Number.parseInt({toString(){return '7'}} as any, 10);",
        "parseFloat({toString(){return '7.5'}} as unknown as string);",
        "Number.parseInt('11', {valueOf(){return 2}} as any);",
        "parseInt(['7'] as any, 10);",
        "parseInt(...['7'] as [string]);",
        "Number.parseFloat('7', ...[]);",
        "Number.parseInt = () => 1; console.log(Number.parseInt('3'));",
        "parseInt = () => 1; console.log(parseInt('3'));",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn property_presence_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "property-presence-boundary");
    for source in [
        "({toString(){return 'field'}} as any) in {field: 1};",
        "({toString(){return 'field'}} as unknown as string) in {field: 1};",
        "const key = Symbol('field'); console.log(key in {[key]: 1});",
        "console.log('constructor' in {__proto__: null});",
        "const data = {}; Object.setPrototypeOf(data, {inherited: 1}); console.log('inherited' in data);",
        "console.log('field' in new Proxy({}, {has(){return true}}));",
        "console.log('length' in []);",
        "console.log('size' in new Set());",
        "console.log('length' in (() => 1));",
        "class Packet {field = 1} console.log('field' in new Packet());",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn erased_property_presence_refuses_exotic_layouts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "erased-presence-boundary");
    fs::write(&input, r#"// @ts-nocheck
function check(value: unknown, key: unknown): void {
  try { console.log(key in value); }
  catch (error) {
    if (!(error instanceof TypeError) || !error.message.includes("exotic prototype presence is not ported")) throw error;
    console.log("refused");
  }
}

check([], "length"); check([], Symbol.iterator);
check(() => 1, "length"); check(() => 1, Symbol.iterator);
check(new Map(), "size"); check(/x/, "source");
class Packet { value = 1; }
check(new Packet(), "value");
"#).unwrap();
    let output = Command::new(compiler())
        .arg("build")
        .arg(&input)
        .args(["--no-engine", "--out"])
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = Command::new(&target)
        .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout)
            .unwrap()
            .replace("\r\n", "\n"),
        "refused\n".repeat(7)
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn switch_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "switch-boundary");
    for source in [
        "switch (1) { case 1: let value = 3; case 2: console.log(value); }",
        "function run(value: number) { switch (value) { default: const local = 2; return local; } } run(1);",
        "switch (1) { default: continue; }",
        "outer: switch (1) { default: break outer; }",
        "switch (new Set([1])) { default: break; }",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn array_sort_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "array-sort-boundary");
    for source in [
        "const values = ['b', 'a']; values.sort((a, b) => a.localeCompare(b));",
        "const values = [3, 1]; values.sort();",
        "const values = ['b', 'a']; values.sort(undefined);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn regex_capture_guard_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "regex-guard-boundary");
    for tail in [
        "const other = alias; other[1] = undefined; return use(alias[1]);",
        "change(alias); return use(alias[1]);",
        "return use(alias[2]);",
        "return pair(change(alias), alias[1]);",
    ] {
        let source = format!(
            "// @ts-nocheck\nfunction use(value: string): string {{ return value; }}\nfunction change(value: RegExpExecArray): string {{ value[1] = undefined; return 'x'; }}\nfunction pair(a: string, b: string): string {{ return a + b; }}\nfunction test(): string {{ const alias = /(a)/.exec('a'); if (alias?.[1] === undefined) throw new Error('absent'); {tail} }}\nconsole.log(test());\n"
        );
        let guarded_read = source.rfind("alias[").unwrap();
        fs::write(&input, source).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{tail}: {stderr}"
        );
        assert!(
            stderr.contains(&format!(":{guarded_read}..{}:", guarded_read + 8))
                || stderr.contains(&format!(":{}..{}:", guarded_read - 1, guarded_read + 8)),
            "{tail}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn string_split_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "string-split-boundary");
    for source in [
        "'abc'.split();",
        "'abc'.split(/(b)?/);",
        "'abc'.split(/(a)|(b)/);",
        "'abc'.split(/((b))/);",
        "let separator = /b/; 'abc'.split(separator);",
        "const separator = new RegExp('b'); 'abc'.split(separator);",
        "'abc'.split('b', 1);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn erased_constructor_refusal_preserves_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "erased-constructor");
    fs::write(&input, "function make(Bottleneck: any) { return new Bottleneck.Group({ id: 'global' }); }\nmake({});\n").unwrap();
    let artifacts = [
        &target,
        &target.with_extension("rs"),
        &target.with_extension("ir.json"),
    ];
    for artifact in artifacts { fs::write(artifact, "preserve").unwrap(); }
    let output = Command::new(compiler()).arg("build").arg(&input)
        .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success() && stderr.contains("SCN1001")
        && stderr.contains("constructor identity is not represented")
        && !stderr.contains("panicked"), "{stderr}");
    for artifact in artifacts { assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve"); }
}

#[test]
fn string_match_unsupported_overloads_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "string-match-boundary");
    for source in ["'abc'.match();", "'abc'.match('b');", "'abc'.match(/b/, /c/);"] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [&target, &target.with_extension("rs"), &target.with_extension("ir.json")];
        for artifact in artifacts { fs::write(artifact, "preserve").unwrap(); }
        let output = Command::new(compiler()).arg("build").arg(&input)
            .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in artifacts { assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve"); }
    }
}

#[test]
fn optional_call_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "optional-call-boundary");
    for source in [
        "function f(s: string | null) { return s?.split(); } f(null);",
        "function f(s: string | null) { return s?.split(/(a)?/); } f(null);",
        "function f(s: string | null) { return s?.split(...[',']); } f(null);",
        "const s: string = 'x'; s.split?.(',');",
        "const obj: any = {}; obj?.method();",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [&target, &target.with_extension("rs"), &target.with_extension("ir.json")];
        for artifact in artifacts { fs::write(artifact, "preserve").unwrap(); }
        let output = Command::new(compiler()).arg("build").arg(&input)
            .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in artifacts { assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve"); }
    }
}

#[test]
fn array_at_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "array-at-boundary");
    for source in [
        "const a = ['a']; a.at('0');",
        "const a = ['a']; a.at(0, 1);",
        "const a = ['a']; a.at(...[0]);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [&target, &target.with_extension("rs"), &target.with_extension("ir.json")];
        for artifact in artifacts { fs::write(artifact, "preserve").unwrap(); }
        let output = Command::new(compiler()).arg("build").arg(&input)
            .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in artifacts { assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve"); }
    }
}

#[test]
fn prototype_has_own_call_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "has-own-call-boundary");
    for source in [
        "Object.prototype.hasOwnProperty.call({}, 1);",
        "Object.prototype.hasOwnProperty.call({});",
        "Object.prototype.hasOwnProperty.call({}, 'x', 1);",
        "Object.prototype.hasOwnProperty.call(...[{}, 'x']);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [&target, &target.with_extension("rs"), &target.with_extension("ir.json")];
        for artifact in artifacts { fs::write(artifact, "preserve").unwrap(); }
        let output = Command::new(compiler()).arg("build").arg(&input)
            .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"), "{source}: {stderr}");
        for artifact in artifacts { assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve"); }
    }
}

#[test]
fn array_find_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "array-find-boundary");
    for source in [
        "const values: number[] = [1]; const predicate = (value: number) => value === 1; values.find(predicate);",
        "const values: any[] = [1]; values.find(123);",
        "const values: any[] = [1]; values.find();",
        "const values: any[] = [1]; values.find(...[() => true]);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn array_rest_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "array-rest-boundary");
    for source in [
        "function run() { const [...rest] = 'abc'; console.log(rest); } run();",
        "function run(value: any) { const [...rest] = value; console.log(rest); } run([1]);",
        "function run() { const [...rest] = new Set([1]); console.log(rest); } run();",
        "const [...rest] = [1, 2]; console.log(rest);",
        "function run() { const [x = 1, ...rest] = [2]; console.log(x, rest); } run();",
        "function run() { const [[x], ...rest] = [[2]]; console.log(x, rest); } run();",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn for_of_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mts");
    let target = binary(temp.path(), "for-of-boundary");
    for source in [
        "for (var value of [1]) console.log(value);",
        "let value = 0; for (value of [1]) console.log(value);",
        "for (const [[value]] of [[[1]]]) console.log(value);",
        "for (const {value} of [{value: 1}]) console.log(value);",
        "async function run(){ for await (const value of [1]) console.log(value); } run();",
        "for (const value of new Set([1])) console.log(value);",
        "for (const value of new Map([[1, 2]])) console.log(value);",
        "for (const value of [] as const) console.log(value);",
        "const array = [1]; array[Symbol.iterator] = () => ({next: () => ({done: true})}); for (const value of array) console.log(value);",
        "outer: for (const value of [1]) { break outer; }",
        "for (const value of [1]) { const fn = () => { continue; }; fn(); }",
        "for (const value of [1]) { const fn = () => { break; }; fn(); }",
        "for (const value of value) console.log(value);",
        "const values = [1]; const index = 0; values[index] = 2;",
        "const values = [1]; values[0.5] = 2;",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn local_inferred_call_and_completion_boundaries_preserve_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.mjs");
    let target = binary(temp.path(), "call-abi-boundary");
    fs::write(temp.path().join("tsconfig.json"), serde_json::to_vec(&serde_json::json!({"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","allowJs":true,"checkJs":false,"strict":true,"types":["node"],"typeRoots":[root().join("node_modules/@types")],"skipLibCheck":true}})).unwrap()).unwrap();
    fs::write(temp.path().join("package.json"), "{\"type\":\"module\"}").unwrap();
    fs::create_dir(temp.path().join("lib")).unwrap();
    for name in ["index.js", "index.d.ts"] {
        fs::copy(
            root()
                .join("tests/corpus/rust-native-local-call-abi/lib")
                .join(name),
            temp.path().join("lib").join(name),
        )
        .unwrap();
    }
    let import = "import {makePlan} from \"./lib/index.js\";\n";
    for source in [
        "function run(value) { let plan = makePlan({value}); console.log(plan.width); } run(1);",
        "const plan = makePlan({value:1}); console.log(plan.width);",
        "function run(value) { /** @type {{width: string, fit: string, active: boolean, nested: {value: number}}} */ const plan = makePlan({value}); console.log(plan.width); } run(1);",
        "/** @param {{}} options */ function run(options = {}) { return options.width; } console.log(run());",
        "/** @type {(options?: {}) => unknown} */ const run = (options = {}) => options.width; console.log(run());",
    ] {
        fs::write(&input, format!("{import}{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
    let typed = temp.path().join("main.ts");
    for source in [
        "function run(value: boolean): number { if(value)return 1; } run(true);",
        "const run: (value:boolean)=>number = value => {if(value)return 1;}; run(true);",
        "function run(): number { return; } run();",
        "function run(options: {} = {}) { return options.width; } console.log(run());",
    ] {
        fs::write(&typed, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let output = Command::new(compiler())
            .arg("build")
            .arg(&typed)
            .args(["--no-engine", "--out"])
            .arg(&target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "preserve");
    }
}

#[test]
fn number_fixed_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "number-fixed-boundary");
    for source in [
        "new Number(1).toFixed(2);",
        "('1' as unknown as number).toFixed(2);",
        "(1).toFixed({valueOf(){return 2}} as any);",
        "(1).toFixed(...[2] as [number]);",
        "const fixed = (1).toFixed; fixed(2);",
        "(1).toFixed.call(1, 2);",
        "Number.prototype.toFixed = () => 'changed'; console.log((1).toFixed(2));",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn tuple_numeric_boundaries_preserve_existing_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "tuple-numeric-boundary");
    for source in [
        "const a=['x','y'] as const; function read(key:string){return a[key as any];} read('0');",
        "const a=['x','y'] as const; const key={toString(){return '0'}}; console.log(a[key as any]);",
        "const a=['x','y'] as const; let key=0n; console.log(a[key as any]);",
        "const a=['x','y'] as const; let key=true; console.log(a[key as any]);",
        "const a:[number|undefined,number]=[1,2]; function read(key:number){console.log(a[key]);} read(0);",
        "const a:[number?]=[1]; function read(key:number){console.log(a[key]);} read(0);",
        "const a=[1,2] as const; function read(key:number):number{return a[key];} read(9);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn sequence_binding_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "sequence-boundary");
    for source in [
        "const [value=1]=[undefined];",
        "const [...values]=[1,2];",
        "const [[value]]=[[1]];",
        "const [value]:number[]=[1];",
        "var [value]=[1];",
        "function f([value]=[1]){} f();",
        "for(const [value=1] of [[1]]){}",
        "const [value]=new Map([['a',1]]);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
            !output.status.success() && stderr.contains("SCN1001") && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn numeric_object_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "numeric-boundary");
    for source in [
        "const object={value:1}; console.log(object / 2);",
        "const object={valueOf:()=>1}; console.log(object * 2);",
        "console.log([1] - 2);",
        "const callable=()=>1; console.log(callable ** 2);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
                && stderr.contains("numeric object coercion hooks are not ported")
                && !stderr.contains("panicked"),
            "{source}: {stderr}"
        );
        for artifact in artifacts {
            assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
        }
    }
}

#[test]
fn string_construction_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "string-construction-boundary");
    for source in [
        "console.log(String.fromCharCode({valueOf:()=>65}));",
        "console.log(String.fromCodePoint([65]));",
        "console.log(String.fromCharCode(({valueOf:()=>65}) as number));",
        "console.log(String.fromCodePoint(...[65,66]));",
        "console.log(String.fromCharCode(...new Uint8Array([65])));",
        "const make=String.fromCharCode; console.log(make(65));",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
fn set_iterator_lifetime_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "set-iterator-boundary");
    for source in [
        "const s=new Set([1,2]); const i=s.values(); s.delete(1); console.log(i.next().value);",
        "const s=new Set([1]); let n=0; console.log(s.values().next(n++).value,n);",
        "const s=new Set([1]); console.log(s.values()?.next().value);",
        "const s=new Set([1]); s.values=()=>({next:()=>({value:99})}); console.log(s.values().next().value);",
        "const f=()=>1; const s=new Set([f]); console.log(s.values().next().value===f);",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
fn floating_array_boundaries_preserve_previous_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "floating-array-boundary");
    for source in [
        "console.log(new Float32Array(new ArrayBuffer(16),4,2));",
        "console.log(new Float64Array([1]).byteOffset);",
        "console.log(new Float32Array([1]).map(x=>x+1));",
        "const values=new Float32Array(1); values['0']=2;",
        "const values=new Float32Array(1); values[0]={valueOf:()=>2};",
        "console.log(new Float32Array({length:1,0:2}));",
        "console.log(new Float32Array([1]).set(new Float64Array([2])));",
        "const make=Float32Array; console.log(new make([1]));",
    ] {
        fs::write(&input, format!("// @ts-nocheck\n{source}\n")).unwrap();
        let artifacts = [
            &target,
            &target.with_extension("rs"),
            &target.with_extension("ir.json"),
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
fn numeric_union_refusal_reports_the_runtime_arms() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "numeric-union-boundary");
    fs::write(&input, "const data = new Uint8Array(0); const x: number = true ? data[1]! : 0; console.log(x);\n").unwrap();
    let output = Command::new(compiler()).arg("build").arg(&input)
        .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success() && stderr.contains("native representation coercion is not ported") && stderr.contains("F64") && stderr.contains("Undefined") && !stderr.contains("panicked"), "{stderr}");
    assert!(!target.exists());
}

#[test]
fn typed_array_named_key_refuses_unrepresentable_scalar_storage() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "bytes-named-key-boundary");
    fs::write(&input, "const b = new Uint8Array([1]); const i = true ? b[9]! : 0; const x: number = b?.[i!] ?? 7; console.log(x);\n").unwrap();
    let output = Command::new(compiler()).arg("build").arg(&input)
        .args(["--no-engine", "--out"]).arg(&target).output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success() && stderr.contains("named-key value requires an owning dynamic contract") && !stderr.contains("panicked"), "{stderr}");
    assert!(!target.exists());
}

#[test]
fn constructor_union_rejects_incompatible_argument_contracts() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "constructor-union-boundary");
    fs::write(&input, "// @ts-nocheck\nclass A { constructor(x: number) {} } class B extends A { constructor(x: string) { super(1); } } function use(C: typeof A | typeof B) { return new C(1); } use(A);\n").unwrap();
    for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] { fs::write(artifact, "preserve").unwrap(); }
    let output = Command::new(compiler()).arg("build").arg(&input).args(["--no-engine", "--out"]).arg(&target).output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success() && stderr.contains("constructor union argument contracts differ") && !stderr.contains("panicked"), "{stderr}");
    for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] { assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve"); }
}

#[test]
fn unrelated_class_return_union_reports_identity_boundary() {
    let temp = tempfile::tempdir().unwrap();
    metadata_project(temp.path());
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "class-return-union-boundary");
    fs::write(&input, "class Circle { radius = 1 } class Square { side = 2 } function create(c: typeof Circle | typeof Square): Circle | Square { return new c(); } create(Circle);\n").unwrap();
    for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] {
        fs::write(artifact, "preserve").unwrap();
    }
    let output = Command::new(compiler()).arg("build").arg(&input).args(["--no-engine", "--out"]).arg(&target).output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success() && stderr.contains("function return union of class instances needs a shared identity contract") && !stderr.contains("panicked"), "{stderr}");
    for artifact in [&target, &target.with_extension("ir.json"), &target.with_extension("rs")] {
        assert_eq!(fs::read_to_string(artifact).unwrap(), "preserve");
    }
}
