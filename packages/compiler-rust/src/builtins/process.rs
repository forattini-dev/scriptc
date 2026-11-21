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
    entries.push(Api::native(
        "process",
        "getuid",
        Lowering::Direct,
        vec![call!("process.getuid", [], Type::F64, "process_getuid")],
        "Zero-argument native Unix user id call; the function property is undefined for Windows targets so ordinary presence guards retain Node semantics",
        &["tests/corpus/5291-process-getuid.ts"],
    ));
    entries.push(Api::native(
        "process",
        "uptime",
        Lowering::Direct,
        vec![call!("process.uptime", [], Type::F64, "process_uptime")],
        "Monotonic seconds since native process creation",
        &["packages/compiler-rust/tests/native.rs"],
    ));
    entries.push(Api::native("process", "kill", Lowering::Special,
        vec![call!("process.killNum", [Type::F64, Type::F64], Bool, "process_kill_num"),
             call!("process.killNamed", [Type::F64, Type::String], Bool, "process_kill_named")],
        "Numeric PID (including Unix negative process groups) and represented numeric or named signal; signal zero performs a native permission/liveness probe and named signals use the native Rust signal table",
        &["tests/corpus/rust-native-platform/process-probe.ts", "tests/corpus/rust-native-platform/process-kill-named.ts"]));
    entries.push(Api::native("process", "exit", Lowering::Special,
        vec![call!("process.exit", [Type::F64], Type::Void, "process_exit"),
             call!("process.exitDefault", [], Type::Void, "process_exit_default")],
        "Immediate termination with an optional numeric exit code; exit listeners and nonnumeric arguments are not ported",
        &["tests/corpus/rust-native-process/exit.ts"]));
    entries.push(Api::native(
        "process",
        "exitCode.set",
        Lowering::Special,
        vec![call!(
            "process.exitCodeSet",
            [Type::F64],
            Type::Void,
            "process_exit_code_set"
        )],
        "Numeric process.exitCode assignment retained until normal native shutdown",
        &["packages/compiler-rust/tests/native.rs"],
    ));
    entries.push(Api::native(
        "process",
        "emitWarning",
        Lowering::Special,
        vec![Builtin {
            ir: "process.emitWarning",
            args: vec![Type::Dyn, Type::Dyn, Type::Dyn, Type::Dyn],
            result: Type::Void,
            implementation: Implementation::Emitter("process"),
        }],
        "Warning value and optional type/code/options metadata evaluated in source order and rendered to the native diagnostic stream; listener interception is not ported",
        &["tests/corpus/rust-native-process/emit-warning.ts"],
    ));
    for op in [
        call!("process.version", [], String, "process_version"),
        call!("process.arch", [], String, "process_arch"),
        call!("process.platform", [], String, "process_platform"),
        call!("process.execPath", [], String, "process_exec_path"),
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
    let mut pid = Api::native(
        "process",
        "pid",
        Lowering::Property,
        vec![call!("process.pid", [], Type::F64, "process_pid")],
        "Live declaration/import-proven process identifier",
        &["tests/corpus/rust-native-platform/open-numeric.ts"],
    );
    pid.access = Access::Property;
    entries.push(pid);
    let mut argv = Api::native(
        "process",
        "argv",
        Lowering::Property,
        vec![call!(
            "process.argv",
            [],
            Type::Array {
                elem: Box::new(Type::String)
            },
            "process_argv"
        )],
        "Shared mutable argument array; native executable occupies both executable and script slots, followed by command-line arguments",
        &["tests/corpus/rust-native-process/argv.ts"],
    );
    argv.access = Access::Property;
    entries.push(argv);
    entries.push(Api::special(
        "process", "on", Access::Call,
        "process.onUnhandledRejection", "promise_set_unhandled_rejection_handler",
        "Discarded exception, exit, monitor and signal listener registrations; lifecycle removal preserves function identity and monitors never handle the observed error",
        &["tests/corpus/rust-native-process/unhandled-rejection.ts", "tests/corpus/rust-native-process/uncaught-exception.ts", "tests/corpus/5296-process-lifecycle-listeners.js"],
    ));
    entries.push(Api::special(
        "process", "once", Access::Call,
        "process.onNamedSignal", "process_signal_on",
        "Discarded once-only signal registration; literal and represented string signal names are validated natively",
        &["packages/compiler-rust/tests/native.rs"],
    ));
    entries.push(Api::special(
        "process",
        "off",
        Access::Call,
        "process.offNamedSignal",
        "process_signal_off",
        "Discarded signal listener removal by the original callback identity",
        &["packages/compiler-rust/tests/native.rs"],
    ));
    let mut env = Api::native(
        "process",
        "env",
        Lowering::Special,
        vec![Builtin {
            ir: "process.envObject",
            args: vec![],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper("native_process_env_object"),
        }],
        "Live keyed reads and writes plus an owning snapshot when process.env crosses a value boundary",
        &[
            "tests/corpus/rust-native-process/reads.ts",
            "tests/corpus/rust-native-process/imports.ts",
        ],
    );
    env.access = Access::Property;
    entries.push(env);
    let mut stdin = Api::native(
        "process",
        "stdin",
        Lowering::Property,
        vec![
            Builtin {
                ir: "process.stdinValue",
                args: vec![],
                result: Type::Dyn,
                implementation: Implementation::NativeHelper("native_process_stdin_value"),
            },
            call!(
                "process.stdinNext",
                [],
                Type::Promise {
                    inner: Box::new(Type::bytes())
                },
                "stdin_next_chunk"
            ),
            call!("process.stdinPause", [], Type::Void, "stdin_pause"),
        ],
        "Stable native stdin stream value with data listeners, raw mode, pause/resume and an async byte-chunk iterator",
        &[
            "tests/corpus/4960-process-stdin-value.ts",
            "tests/corpus/rust-native-process/stdin-async.ts",
        ],
    );
    stdin.access = Access::Property;
    entries.push(stdin);
    let mut stdout = Api::native(
        "process",
        "stdout",
        Lowering::Property,
        vec![Builtin {
            ir: "process.stdoutValue",
            args: vec![],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper("native_process_stdout_value"),
        }],
        "Stable owning process stream value with native isTTY and string write support",
        &["tests/corpus/4947-process-stream-values.ts"],
    );
    stdout.access = Access::Property;
    entries.push(stdout);
    let mut stderr = Api::native(
        "process",
        "stderr",
        Lowering::Property,
        vec![Builtin {
            ir: "process.stderrValue",
            args: vec![],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper("native_process_stderr_value"),
        }],
        "Stable owning process stream value with native isTTY and string write support",
        &["tests/corpus/4947-process-stream-values.ts"],
    );
    stderr.access = Access::Property;
    entries.push(stderr);
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
    for (name, op) in [
        (
            "stdout.write",
            vec![
                call!(
                    "process.stdoutWrite",
                    [Type::String],
                    Bool,
                    "process_stdout_write"
                ),
                call!(
                    "process.stdoutWriteBytes",
                    [Type::bytes(), Type::String],
                    Bool,
                    "process_stdout_write_bytes"
                ),
            ],
        ),
        (
            "stderr.write",
            vec![
                call!(
                    "process.stderrWrite",
                    [Type::String],
                    Bool,
                    "process_stderr_write"
                ),
                call!(
                    "process.stderrWriteBytes",
                    [Type::bytes(), Type::String],
                    Bool,
                    "process_stderr_write_bytes"
                ),
            ],
        ),
    ] {
        entries.push(Api::native(
            "process", name, Lowering::Special, op,
            "Direct string or native byte-buffer write, including contextually void arrow bodies; default UTF-8, no automatic newline. Stream values, explicit encodings, completion callbacks, mutation and error events are not ported",
            &["tests/corpus/rust-native-process-writes/contracts.ts", "tests/corpus/rust-native-process-writes/callbacks.ts", "tests/corpus/rust-native-process-writes/order.ts"],
        ));
    }
    entries.extend([
        Api::runtime_only("process", "chdir", Access::Call, &["process_chdir"],
            "Runtime chdir exists; native argument validation and process error fields still need parity tests"),
    ]);
    entries
}
