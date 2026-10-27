//! Native API contracts and their typed IR -> Rust bindings.
//! Module recognition, source API identity and internal operations are separate.
use crate::ir::Type;
use serde::Serialize;

pub fn strings() -> Type {
    Type::Array {
        elem: Box::new(Type::String),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "symbol", rename_all = "kebab-case")]
pub enum Implementation {
    Runtime(&'static str),
    NativeHelper(&'static str),
    FloatMethod(&'static str),
    FloatBinaryMethod(&'static str),
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Builtin {
    pub ir: &'static str,
    pub args: Vec<Type>,
    pub result: Type,
    pub implementation: Implementation,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    NativePartial,
    RuntimeOnly,
    Planned,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    Call,
    Property,
    Construct,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lowering {
    Direct,
    Primitive,
    PathVariadic,
    PathBasename,
    Directory,
    AppendFile,
    ReadFile,
    Descriptor,
    Buffer,
    Property,
    Special,
    Unported,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialBinding {
    ir: &'static str,
    runtime: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Api {
    pub module: &'static str,
    pub member: &'static str,
    pub stage: Stage,
    pub access: Access,
    pub lowering: Lowering,
    pub operations: Vec<Builtin>,
    pub runtime_candidates: &'static [&'static str],
    pub special: Option<SpecialBinding>,
    pub contract: &'static str,
    pub evidence: &'static [&'static str],
}
impl Api {
    fn native(
        module: &'static str,
        member: &'static str,
        lowering: Lowering,
        operations: Vec<Builtin>,
        contract: &'static str,
        evidence: &'static [&'static str],
    ) -> Self {
        Self {
            module,
            member,
            stage: Stage::NativePartial,
            access: Access::Call,
            lowering,
            operations,
            runtime_candidates: &[],
            special: None,
            contract,
            evidence,
        }
    }
    fn runtime_only(
        module: &'static str,
        member: &'static str,
        access: Access,
        runtime_candidates: &'static [&'static str],
        contract: &'static str,
    ) -> Self {
        Self {
            module,
            member,
            stage: Stage::RuntimeOnly,
            access,
            lowering: Lowering::Unported,
            operations: vec![],
            runtime_candidates,
            special: None,
            contract,
            evidence: &[],
        }
    }
    fn special(
        module: &'static str,
        member: &'static str,
        access: Access,
        ir: &'static str,
        runtime: &'static str,
        contract: &'static str,
        evidence: &'static [&'static str],
    ) -> Self {
        Self {
            module,
            member,
            stage: Stage::NativePartial,
            access,
            lowering: Lowering::Special,
            operations: vec![],
            runtime_candidates: &[],
            special: Some(SpecialBinding { ir, runtime }),
            contract,
            evidence,
        }
    }
}
macro_rules! call {
    ($ir:literal, [$($arg:expr),*], $result:expr, $runtime:literal) => {
        Builtin { ir: $ir, args: vec![$($arg),*], result: $result, implementation: Implementation::Runtime($runtime) }
    };
}
use Type::{Bool, String};
mod buffer;
mod bun;
mod crypto;
mod filesystem;
mod math;
mod number;
mod path;
mod platform;
mod process;
mod string;
#[cfg(test)]
mod tests;

pub fn apis() -> &'static [Api] {
    static APIS: std::sync::OnceLock<Vec<Api>> = std::sync::OnceLock::new();
    APIS.get_or_init(|| {
        [
            math::apis(),
            number::apis(),
            string::apis(),
            buffer::apis(),
            path::apis(),
            platform::apis(),
            filesystem::apis(),
            process::apis(),
            crypto::apis(),
            bun::apis(),
        ]
        .into_iter()
        .flatten()
        .collect()
    })
}
pub fn source(module: &str, member: &str) -> Option<&'static Api> {
    entry(module, member)
        .filter(|api| api.stage == Stage::NativePartial && api.access == Access::Call)
}
pub fn entry(module: &str, member: &str) -> Option<&'static Api> {
    apis()
        .iter()
        .find(|api| api.module == module && api.member == member)
}
pub fn get(module: &str, member: &str) -> Option<Builtin> {
    source(module, member)?.operations.first().cloned()
}
pub fn property(module: &str, member: &str) -> Option<Builtin> {
    apis()
        .iter()
        .find(|api| {
            api.module == module
                && api.member == member
                && api.stage == Stage::NativePartial
                && api.access == Access::Property
        })?
        .operations
        .first()
        .cloned()
}
pub fn by_ir(name: &str) -> Option<Builtin> {
    apis()
        .iter()
        .flat_map(|api| &api.operations)
        .find(|op| op.ir == name)
        .cloned()
        .or_else(|| {
            math::internal()
                .into_iter()
                .chain(buffer::internal())
                .find(|op| op.ir == name)
        })
}
/// An implementation inventory, not a complete Node/Bun compatibility matrix.
pub fn manifest() -> serde_json::Value {
    let strings = crate::string_builtins::OPERATIONS.iter().map(|op| serde_json::json!({
        "module": "String.prototype", "member": op.method, "stage": "native-partial",
        "access": if op.method == "length" { "property" } else { "call" },
        "irNode": "StringIntrinsic", "runtime": op.runtime,
        "args": op.args.iter().map(|arg| arg.ty()).collect::<Vec<_>>(), "result": op.result,
        "contract": "Represented string receiver; eager primitive conversion with registered defaults; object coercion and iterable spreads refused",
        "evidence": ["tests/corpus/rust-native-primitives/strings.ts", "tests/corpus/rust-native-primitives/utf16.ts"]
    })).collect::<Vec<_>>();
    serde_json::json!({"schemaVersion": 1, "engine": "none", "fallback": false,
        "nodeOracle": "24.15.0", "bunOracle": null,
        "scope": "Tracked native API families only; runtime-only entries are reuse candidates, planned entries are not supported. The Node compatibility census remains in internal/compatibility.",
        "apis": apis(), "stringIntrinsics": strings})
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
        // Recognition is independent of implementation. Demand lowering still
        // refuses members with no native source contract.
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
