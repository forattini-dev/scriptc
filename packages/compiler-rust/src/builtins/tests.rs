use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[test]
fn source_contracts_are_unique_and_bind_only_implemented_operations() {
    let mut names = BTreeSet::new();
    let mut operations = BTreeMap::new();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for api in apis() {
        assert!(
            names.insert((api.module, api.member)),
            "duplicate source API"
        );
        assert!(!api.contract.is_empty());
        if api.stage != Stage::NativePartial {
            assert!(api.operations.is_empty());
            assert!(source(api.module, api.member).is_none());
            assert!(get(api.module, api.member).is_none());
            continue;
        }
        assert!(!api.evidence.is_empty(), "{}", api.member);
        for evidence in api.evidence {
            assert!(root.join(evidence).is_file(), "missing evidence {evidence}");
        }
        assert!(!api.operations.is_empty() || api.special.is_some());
        if api.access == Access::Call {
            assert!(!api.operations.is_empty());
        }
        for op in &api.operations {
            if let Some(previous) = operations.insert(op.ir, op) {
                assert_eq!(previous, op, "conflicting ABI for {}", op.ir);
            }
            assert_eq!(by_ir(op.ir).as_ref(), Some(op));
        }
    }
}

#[test]
fn internal_operations_never_manufacture_source_exports() {
    for member in ["size", "isFile", "isDirectory", "isSymbolicLink"] {
        assert!(get("fs", member).is_none());
        assert!(by_ir(&format!("stats.{member}")).is_some());
    }
    for name in [
        "appendFileModeSync",
        "mkdirModeSync",
        "mkdirRecursiveSync",
        "mkdirRecursiveModeSync",
    ] {
        assert!(get("fs", name).is_none());
        assert!(by_ir(&format!("fs.{name}")).is_some());
    }
    assert!(get("process", "isTTY").is_none());
    assert!(by_ir("process.isTTY").is_some());
    assert!(get("Number", "fromString").is_none());
    assert!(by_ir("num.fromString").is_some());
    for name in ["arch", "platform"] {
        assert!(get("process", name).is_none());
        assert_eq!(property("process", name).unwrap().result, Type::String);
    }
}

#[test]
fn runtime_reuse_candidates_name_existing_rust_functions() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime-rust/src");
    let source = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .map(|path| std::fs::read_to_string(path).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for api in apis() {
        let mut symbols = api.runtime_candidates.to_vec();
        symbols.extend(
            api.operations
                .iter()
                .filter_map(|op| match op.implementation {
                    Implementation::Runtime(name) => Some(name),
                    _ => None,
                }),
        );
        if let Some(binding) = &api.special {
            symbols.push(binding.runtime);
        }
        for symbol in symbols {
            assert!(
                source.contains(&format!("pub fn {symbol}(")),
                "missing runtime symbol {symbol}"
            );
        }
    }
}

#[test]
fn module_aliases_and_unported_families_remain_explicit() {
    assert_eq!(module("node:fs"), Some("fs"));
    assert_eq!(module("node:crypto"), Some("crypto"));
    assert_eq!(module("path/posix"), Some("path"));
    assert_eq!(
        module("node:path"),
        Some(if cfg!(windows) { "path/win32" } else { "path" })
    );
    assert_eq!(module("bun"), None);
    assert_eq!(entry("process", "argv").unwrap().access, Access::Property);
    assert_eq!(
        entry("Bun", "CryptoHasher").unwrap().access,
        Access::Construct
    );
    let report = manifest();
    assert_eq!(report["engine"], "none");
    assert_eq!(report["fallback"], false);
    assert_eq!(report["bunOracle"], serde_json::Value::Null);
    let apis = report["apis"].as_array().unwrap();
    assert!(apis.iter().any(|row| row["module"] == "crypto"
        && row["member"] == "createHash"
        && row["stage"] == "runtime-only"));
    assert!(
        apis.iter().any(|row| row["module"] == "Bun"
            && row["member"] == "file"
            && row["stage"] == "planned")
    );
}
