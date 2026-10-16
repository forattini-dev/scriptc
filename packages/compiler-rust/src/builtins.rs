//! Implemented native library calls, sharing the existing IR/runtime ABI.
use crate::ir::Type;

pub fn strings() -> Type {
    Type::Array {
        elem: Box::new(Type::String),
    }
}

#[derive(Clone)]
pub struct Builtin {
    pub module: &'static str,
    pub member: &'static str,
    pub ir: &'static str,
    pub args: Vec<Type>,
    pub result: Type,
    pub runtime: &'static str,
}

macro_rules! call {
    ($module:literal, $member:literal, $ir:literal, [$($arg:expr),*], $result:expr, $runtime:literal) => {
        Builtin { module: $module, member: $member, ir: $ir, args: vec![$($arg),*], result: $result, runtime: $runtime }
    };
}

use Type::{Bool, String};
fn calls() -> &'static [Builtin] {
    static CALLS: std::sync::OnceLock<Vec<Builtin>> = std::sync::OnceLock::new();
    CALLS.get_or_init(|| {
        vec![
            call!(
                "path",
                "join",
                "path.join",
                [strings()],
                String,
                "path_join"
            ),
            call!(
                "path",
                "resolve",
                "path.resolve",
                [strings()],
                String,
                "path_resolve"
            ),
            call!(
                "path",
                "normalize",
                "path.normalize",
                [String],
                String,
                "path_normalize"
            ),
            call!(
                "path",
                "dirname",
                "path.dirname",
                [String],
                String,
                "path_dirname"
            ),
            call!(
                "path",
                "basename",
                "path.basename",
                [String, String],
                String,
                "path_basename"
            ),
            call!(
                "path",
                "extname",
                "path.extname",
                [String],
                String,
                "path_extname"
            ),
            call!(
                "path",
                "isAbsolute",
                "path.isAbsolute",
                [String],
                Bool,
                "path_is_absolute"
            ),
            call!(
                "path",
                "relative",
                "path.relative",
                [String, String],
                String,
                "path_relative"
            ),
            call!(
                "path/win32",
                "join",
                "path.win32Join",
                [strings()],
                String,
                "path_win32_join"
            ),
            call!(
                "path/win32",
                "resolve",
                "path.win32Resolve",
                [strings()],
                String,
                "path_win32_resolve"
            ),
            call!(
                "path/win32",
                "normalize",
                "path.win32Normalize",
                [String],
                String,
                "path_win32_normalize"
            ),
            call!(
                "path/win32",
                "dirname",
                "path.win32Dirname",
                [String],
                String,
                "path_win32_dirname"
            ),
            call!(
                "path/win32",
                "basename",
                "path.win32Basename",
                [String, String],
                String,
                "path_win32_basename"
            ),
            call!(
                "path/win32",
                "extname",
                "path.win32Extname",
                [String],
                String,
                "path_win32_extname"
            ),
            call!(
                "path/win32",
                "isAbsolute",
                "path.win32IsAbsolute",
                [String],
                Bool,
                "path_win32_is_absolute"
            ),
            call!(
                "path/win32",
                "relative",
                "path.win32Relative",
                [String, String],
                String,
                "path_win32_relative"
            ),
            call!(
                "fs",
                "existsSync",
                "fs.existsSync",
                [String],
                Bool,
                "fs_exists"
            ),
            call!("os", "homedir", "os.homedir", [], String, "os_homedir"),
            call!("os", "tmpdir", "os.tmpdir", [], String, "os_tmpdir"),
            call!(
                "os",
                "platform",
                "process.platform",
                [],
                String,
                "process_platform"
            ),
            call!("process", "cwd", "process.cwd", [], String, "process_cwd"),
        ]
    })
}

pub fn module(name: &str) -> Option<&'static str> {
    let name = name.strip_prefix("node:").unwrap_or(name);
    match name {
        "path" if cfg!(windows) => Some("path/win32"),
        "path" | "path/posix" => Some("path"),
        "path/win32" => Some("path/win32"),
        "fs" => Some("fs"),
        "os" => Some("os"),
        "process" => Some("process"),
        // Importing these standard modules is inert. Calls remain explicit
        // refusals until their native ABI is represented in CALLS.
        "fs/promises" => Some("fs/promises"),
        "child_process" => Some("child_process"),
        "url" => Some("url"),
        _ => [
            "assert",
            "assert/strict",
            "async_hooks",
            "buffer",
            "console",
            "constants",
            "crypto",
            "dgram",
            "diagnostics_channel",
            "dns",
            "dns/promises",
            "events",
            "http",
            "http2",
            "https",
            "module",
            "net",
            "perf_hooks",
            "querystring",
            "readline",
            "readline/promises",
            "stream",
            "stream/consumers",
            "stream/promises",
            "stream/web",
            "string_decoder",
            "timers",
            "timers/promises",
            "tls",
            "tty",
            "util",
            "util/types",
            "worker_threads",
            "zlib",
        ]
        .into_iter()
        .find(|module| *module == name),
    }
}

pub fn get(module: &str, member: &str) -> Option<Builtin> {
    calls()
        .iter()
        .find(|call| call.module == module && call.member == member)
        .cloned()
}

pub fn by_ir(name: &str) -> Option<Builtin> {
    calls().iter().find(|call| call.ir == name).cloned()
}
