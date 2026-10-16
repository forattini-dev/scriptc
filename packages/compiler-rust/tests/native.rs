//! Node is exclusively the differential oracle, never a compiler dependency.
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn compiler() -> &'static str {
    env!("CARGO_BIN_EXE_scriptc")
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
    let marker = temp.path().join("forbidden-called");
    let mut paths = vec![traps];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    let path = std::env::join_paths(paths).unwrap();
    for (index, name) in [
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
    ]
    .into_iter()
    .enumerate()
    {
        let input = root().join("tests/corpus").join(name);
        let target = binary(temp.path(), &format!("case-{index}"));
        let expected = Command::new(oracle()).arg(&input).output().unwrap();
        success(&expected);
        let build = Command::new(compiler())
            .args(["build"])
            .arg(&input)
            .arg("--out")
            .arg(&target)
            .env("PATH", &path)
            .env("SCRIPTC_FORBIDDEN_MARKER", &marker)
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
            .env("PATH", &path)
            .env("SCRIPTC_FORBIDDEN_MARKER", &marker)
            .env("SCRIPTC_RUST_HEAP_AUDIT", "1")
            .output()
            .unwrap();
        assert_eq!(actual.status.code(), expected.status.code(), "{name}");
        assert_eq!(actual.stdout, expected.stdout, "stdout: {name}");
        assert_eq!(actual.stderr, expected.stderr, "stderr: {name}");
        assert!(
            !marker.exists(),
            "a forbidden compiler/runtime process was invoked"
        );
        let ir: serde_json::Value =
            serde_json::from_slice(&fs::read(target.with_extension("ir.json")).unwrap()).unwrap();
        assert_eq!(ir["irVersion"], 13);
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
fn promise_boundaries_preserve_previous_native_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let target = binary(temp.path(), "promise");
    for source in [
        "Promise.all([]);",
        "Promise.resolve().catch(() => {});",
        "Promise.resolve(1).then(() => 1, () => 2);",
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
            "class Fault extends Error { method(): number { return 1; } }",
        ),
        (
            "accessor",
            "class Fault extends Error { get field(): number { return 1; } }",
        ),
        (
            "shadow",
            "export {}; class Error { message = 'user'; } new Error();",
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
            "async function unsupported(): Promise<number> { return 1; } function root(): void { unsupported(); } root();",
            "call 'unsupported'",
        ),
        (
            "escaping-value",
            "async function unsupported(): Promise<number> { return 1; } const alias = unsupported;",
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
        ("truthiness", "console.log(!1);", "SCN1001"),
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
            "function f(n: number | undefined = undefined) { return 1; } console.log(f());",
            "SCN1001",
        ),
        (
            "optional-call",
            "function f(n?: () => number) { return n?.(); } console.log(f());",
            "SCN1001",
        ),
        (
            "rest-param",
            "function f(...n: number[]) { return 1; } console.log(f());",
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
        ("async", "async function f() { return 1; } f();", "SCN1001"),
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
            "recursive-dictionary",
            "interface Node { next: Record<string, Node> } function f(value: Node): void {} f;",
            "SCN1001",
        ),
        (
            "dictionary-prototype-write",
            "const values: Record<string, boolean> = {}; values['__proto__'] = false;",
            "SCN1001",
        ),
        (
            "recursive-record",
            "interface Link { next?: Link }; function f(link: Link): void {} f;",
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
            "record-method",
            "const record = { value(): number { return 1; } }; console.log(record.value());",
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
            "record-width",
            "function f(record: { n: number }): number { return record.n; } const record = { n: 1, extra: 2 }; console.log(f(record));",
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
    let input = temp.path().join("ação entry.ts");
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
