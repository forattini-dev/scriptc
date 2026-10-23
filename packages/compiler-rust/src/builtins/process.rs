use super::*;
pub(super) fn apis() -> Vec<Api> {
    let mut entries = vec![Api::native(
        "process",
        "cwd",
        Lowering::Direct,
        vec![call!("process.cwd", [], String, "process_cwd")],
        "Zero-argument cwd call; no function-value adapter",
        &["tests/corpus/rust-native-platform/paths.ts"],
    )];
    for op in [
        call!("process.arch", [], String, "process_arch"),
        call!("process.platform", [], String, "process_platform"),
    ] {
        let name = op.ir.strip_prefix("process.").unwrap();
        let mut entry = Api::native(
            "process",
            name,
            Lowering::Property,
            vec![op],
            "Live declaration/import-proven string property; never a source callable",
            &[
                "tests/corpus/rust-native-process/reads.ts",
                "tests/corpus/rust-native-process/imports.ts",
            ],
        );
        entry.access = Access::Property;
        entries.push(entry);
    }
    entries.push(Api::special("process", "env", Access::Property,
        "process.envGet", "process_env_get",
        "Live keyed string read returning string | undefined; writes, enumeration and the environment object as a value are not ported",
        &["tests/corpus/rust-native-process/reads.ts", "tests/corpus/rust-native-process/imports.ts"]));
    for name in ["stdin.isTTY", "stdout.isTTY", "stderr.isTTY"] {
        entries.push(Api::native(
            "process",
            name,
            Lowering::Property,
            vec![call!("process.isTTY", [Type::F64], Bool, "process_is_tty")],
            "Live terminal read adapted to true | undefined; helper is not a process.isTTY export",
            &["tests/corpus/rust-native-process/reads.ts"],
        ));
        entries.last_mut().unwrap().access = Access::Property;
    }
    entries.extend([
        Api::runtime_only("process", "argv", Access::Property, &["process_argv"],
            "Runtime argv exists; native executable argv conventions must be exposed deliberately, not assumed equal to Node's interpreter paths"),
        Api::runtime_only("process", "chdir", Access::Call, &["process_chdir"],
            "Runtime chdir exists; native argument validation and process error fields still need parity tests"),
    ]);
    entries
}
