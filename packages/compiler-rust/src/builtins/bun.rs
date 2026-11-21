use super::*;
pub(super) fn apis() -> Vec<Api> {
    let mut entries = [
        ("CryptoHasher", "Algorithm sets, byte inputs, clone/update/digest lifecycle and encoding need a dedicated class adapter"),
    ].into_iter().map(|(name, contract)| Api {
        module: "Bun", member: name, stage: Stage::Planned,
        access: if name == "CryptoHasher" { Access::Construct } else { Access::Call },
        lowering: Lowering::Unported, operations: vec![], runtime_candidates: &[],
        special: None, contract, evidence: &[],
    }).collect::<Vec<_>>();
    entries.push(Api::native(
        "Bun",
        "file",
        Lowering::Special,
        vec![call!(
            "bun.filePath",
            [Type::String],
            Type::String,
            "bun_file_path"
        ), call!(
            "bun.fileText",
            [Type::String],
            Type::Promise { inner: Box::new(Type::String) },
            "bun_file_text"
        ), call!(
            "bun.fileBytes",
            [Type::String],
            Type::Promise { inner: Box::new(Type::bytes()) },
            "bun_file_bytes"
        ), call!(
            "bun.fileExists",
            [Type::String],
            Type::Promise { inner: Box::new(Type::Bool) },
            "bun_file_exists"
        ), call!(
            "bun.fileSize",
            [Type::String],
            Type::F64,
            "bun_file_size"
        )],
        "A string-path BunFile is represented by its validated native path; text(), bytes(), exists() and size use native Rust filesystem operations for both direct chains and stored handles. Streams, slices and non-string paths remain fenced",
        &["tests/corpus/rust-bun-file-text/main.ts", "tests/corpus/rust-bun-file-text/bytes.ts"],
    ));
    entries.push(Api::native(
        "Bun",
        "write",
        Lowering::Special,
        vec![call!(
            "bun.writeText",
            [Type::String, Type::String],
            Type::Promise { inner: Box::new(Type::F64) },
            "bun_write_text"
        ), call!(
            "bun.writeBytes",
            [Type::String, Type::bytes()],
            Type::Promise { inner: Box::new(Type::F64) },
            "bun_write_bytes"
        )],
        "A represented string destination with a string or Uint8Array payload is written by the native asynchronous Rust path and returns the byte count. BunFile destinations and response/blob sources remain separately fenced",
        &["tests/corpus/rust-bun-write/main.ts"],
    ));
    entries.push(Api::native(
        "Bun",
        "sleep",
        Lowering::Direct,
        vec![call!(
            "bun.sleep",
            [Type::F64],
            Type::Promise {
                inner: Box::new(Type::Void)
            },
            "promise_timeout"
        )],
        "One represented numeric millisecond delay returning a native Promise<void>; Date delays and extra arguments are refused",
        &["tests/corpus/rust-bun-spawn/sleep.ts"],
    ));
    entries.push(Api::native(
        "Bun",
        "connect",
        Lowering::Special,
        vec![Builtin {
            ir: "bun.connect".into(),
            args: vec![
                Type::String,
                Type::F64,
                Type::Dyn,
                Type::Dyn,
                Type::Dyn,
                Type::Dyn,
                Type::Dyn,
            ],
            result: Type::Promise {
                inner: Box::new(Type::Dyn),
            },
            implementation: Implementation::Emitter("network"),
        }],
        "TCP hostname/port connections with native open, data, close, error and connectError handlers; returns a native Promise for the shared socket identity",
        &["tests/corpus/5269-bun-connect/main.ts"],
    ));
    entries.push(Api::native(
        "Bun",
        "$",
        Lowering::Special,
        vec![call!(
            "bun.shellQuietNothrow",
            [strings()],
            Type::Promise {
                inner: Box::new(Type::F64)
            },
            "bun_shell_quiet_nothrow"
        )],
        "Injection-safe static shell words and string substitutions lowered to native argv for the quiet().nothrow() chain; shell operators, quoting and environment mutation remain fenced",
        &["tests/corpus/5270-bun-shell-quiet-nothrow/main.ts"],
    ));
    entries.push(Api::native("Bun", "spawn", Lowering::Special,
        vec![call!("bun.spawn", [strings(), Type::F64, Type::F64, Type::F64, Type::Bool, Type::Bool, strings(), Type::String], Type::Child, "bun_spawn"),
             call!("bun.spawnTimeout", [Type::Child, Type::F64], Type::Child, "bun_subprocess_timeout"),
             call!("bun.stdioMode", [Type::String], Type::F64, "bun_stdio_mode"),
             Builtin { ir: "bun.spawnOptionsCwd", args: vec![Type::Dyn, Type::String], result: Type::String, implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.spawnOptionsEnv", args: vec![Type::Dyn, Type::Dyn], result: Type::Dyn, implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.envPresent", args: vec![Type::Dyn], result: Type::Bool, implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.envPairs", args: vec![Type::Dyn], result: strings(), implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.stdinPresent", args: vec![Type::Child], result: Type::Bool, implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.stdinWrite", args: vec![Type::Child, Type::Dyn], result: Type::Bool, implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.stdinEnd", args: vec![Type::Child], result: Type::Void, implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.stdout", args: vec![Type::Child], result: Type::Dyn, implementation: Implementation::Emitter("child_process") },
             Builtin { ir: "bun.stderr", args: vec![Type::Child], result: Type::Dyn, implementation: Implementation::Emitter("child_process") },
             call!("bun.exited", [Type::Child], Type::Promise { inner: Box::new(Type::F64) }, "bun_subprocess_exited"),
             Builtin { ir: "child.unref", args: vec![Type::Child], result: Type::Void, implementation: Implementation::Emitter("child_process") },
             call!("bun.responseText", [Type::Child, Type::Bool], Type::Promise { inner: Box::new(Type::String) }, "bun_subprocess_response_text")],
        "String argv, literal stdio options, native environment objects, exited and direct Response(pipe).text(); other options and stream APIs require separate contracts.",
        &["tests/corpus/rust-native-bun-spawn/main.ts", "tests/corpus/rust-native-bun-spawn/pipe.ts", "tests/corpus/rust-native-bun-spawn/locked.ts", "tests/corpus/rust-native-bun-spawn/await-pipe.ts", "tests/corpus/rust-native-bun-spawn/failure.ts", "tests/corpus/rust-native-bun-spawn/other-pipes.ts", "tests/corpus/rust-native-bun-spawn/unref.ts"]));
    entries.push(Api::special(
        "Bun",
        "spawnSync",
        Access::Call,
        "bun.spawnSync",
        "child_spawn_sync_full",
        "String argv and literal stdin/stdout/stderr modes are adapted to the shared native Rust synchronous subprocess core; cwd, env and byte-oriented output views remain separately fenced",
        &["tests/corpus/5139-bun-spawn-sync/main.ts"],
    ));
    entries.push(Api::special(
        "Bun",
        "which",
        Access::Call,
        "bun.which",
        "bun_which",
        "Command lookup through the startup PATH or literal PATH/cwd overrides with a native string-or-null result; the single-command function-value view is preserved for dependency injection while stored options remain fenced",
        &["tests/corpus/rust-bun-which/default.ts", "tests/corpus/5197-bun-which-path.ts"],
    ));
    entries.push(Api::native(
        "Bun.TOML",
        "parse",
        Lowering::Direct,
        vec![Builtin {
            ir: "bun.tomlParse",
            args: vec![Type::String],
            result: Type::Dyn,
            implementation: Implementation::Emitter("json_functions"),
        }],
        "TOML text is parsed by the native Rust runtime and materialized directly as owning dynamic data; no JavaScript engine or Bun process is involved",
        &["tests/corpus/5166-bun-toml-parse.ts"],
    ));
    entries
}
