use super::*;

pub(super) fn apis() -> Vec<Api> {
    ["assert", "assert/strict"]
        .into_iter()
        .map(|module| {
            Api::native(
                module,
                "ok",
                Lowering::Direct,
                vec![Builtin {
                    ir: "assert.ok",
                    args: vec![Type::Dyn, Type::String],
                    result: Type::Void,
                    implementation: Implementation::Emitter("values"),
                }],
                "Truthy assertion with an optional eagerly evaluated string message and native AssertionError/ERR_ASSERTION failure",
                &["tests/corpus/5355-node-assert/main.cjs"],
            )
        })
        .collect()
}
