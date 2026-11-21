use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![Api::native(
        "child_process",
        "spawn",
        Lowering::Special,
        vec![
            Builtin {
                ir: "cp.spawn",
                args: vec![Type::String, strings(), Type::Dyn],
                result: Type::Child,
                implementation: Implementation::Emitter("child_process"),
            },
            Builtin {
                ir: "child.on",
                args: vec![Type::Child, Type::String, Type::Dyn],
                result: Type::Child,
                implementation: Implementation::Emitter("child_process"),
            },
            Builtin {
                ir: "child.once",
                args: vec![Type::Child, Type::String, Type::Dyn],
                result: Type::Child,
                implementation: Implementation::Emitter("child_process"),
            },
            Builtin {
                ir: "child.stdinWriteCallback",
                args: vec![Type::Child, Type::bytes(), Type::Dyn],
                result: Type::Bool,
                implementation: Implementation::Emitter("child_process"),
            },
            Builtin {
                ir: "child.stdinEnd",
                args: vec![Type::Child],
                result: Type::Void,
                implementation: Implementation::Emitter("child_process"),
            },
            Builtin {
                ir: "child.stdinEndOptional",
                args: vec![Type::Child],
                result: Type::Void,
                implementation: Implementation::Emitter("child_process"),
            },
        ],
        "String command/argv and literal cwd, env, detached, stdio and windowsHide options use the shared native Rust child-process kernel; terminal event listeners preserve callback order",
        &["tests/corpus/5258-node-spawn-listeners.ts"],
    )]
}
