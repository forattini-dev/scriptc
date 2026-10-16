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
            "const outer = 1; function f(): number { return outer; } console.log(f());",
            "SCN1001",
        ),
        ("loop", "while (true) {}", "SCN1001"),
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
            "function-value",
            "function f() { return 1; } const alias = f; console.log(alias());",
            "SCN1001",
        ),
        (
            "default-param",
            "function f(n: number = 1) { return n; } console.log(f());",
            "SCN1001",
        ),
        (
            "optional-param",
            "function f(n?: number) { return 1; } console.log(f());",
            "SCN1001",
        ),
        ("async", "async function f() { return 1; }", "SCN1001"),
        (
            "generic",
            "function f<T>(n: T) { return n; } console.log(f(1));",
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
fn module_cycles_and_dependency_diagnostics_publish_no_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("main.ts");
    let dependency = temp.path().join("dependency.ts");
    for (source, other, code) in [
        (
            "import './dependency.ts'; console.log('entry');",
            "import './main.ts'; console.log('dependency');",
            "SCN1001",
        ),
        (
            "import { value } from './dependency.ts'; console.log(value);",
            "export const value: number = 'invalid';",
            "TS2322",
        ),
        (
            "import { f } from './dependency.ts'; console.log(f());",
            "const captured = 2; export function f(): number { return captured; }",
            "SCN1001",
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
