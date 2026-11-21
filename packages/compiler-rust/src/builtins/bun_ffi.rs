use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![Api::native(
        "bun:ffi",
        "dlopen",
        Lowering::Special,
        vec![
            call!("bun.ffi.consoleOpen", [], Type::Bool, "win_console_open"),
            call!(
                "bun.ffi.consoleGetMode",
                [Type::Bool, Type::Bytes { elem: "u32".into() }],
                Type::F64,
                "win_console_get_mode"
            ),
            call!(
                "bun.ffi.consoleSetMode",
                [Type::Bool, Type::F64],
                Type::F64,
                "win_console_set_mode"
            ),
            call!(
                "bun.ffi.consoleClose",
                [Type::Bool],
                Type::Void,
                "win_console_close"
            ),
        ],
        "Literal kernel32 console-mode binding translated to safe native Rust operations; arbitrary libraries, symbols, pointers and signatures remain refused",
        &["tests/corpus/5294-bun-ffi-console-mode.ts"],
    )]
}
