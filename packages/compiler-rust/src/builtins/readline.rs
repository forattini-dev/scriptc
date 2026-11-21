use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![Api::native(
        "readline",
        "createInterface",
        Lowering::Direct,
        vec![Builtin {
            ir: "readline.createInterface",
            args: vec![Type::Dyn],
            result: Type::Dyn,
            implementation: Implementation::NativeHelper("native_readline_create"),
        }],
        "A native process-stdin/process-stdout interface with question(callback) and close(); alternate streams, completers, history and terminal editing remain fenced",
        &["tests/corpus/5143-readline-question.ts"],
    )]
}
