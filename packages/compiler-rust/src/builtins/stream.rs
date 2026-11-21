use super::*;

pub(super) fn apis() -> Vec<Api> {
    let mut entries = vec![Api::native(
        "stream",
        "pipeline",
        Lowering::Direct,
        vec![Builtin {
            ir: "stream.pipeline",
            args: vec![Type::Dyn, Type::Dyn, Type::Dyn],
            result: Type::Dyn,
            implementation: Implementation::Emitter("values"),
        }],
        "Pumps a native byte ReadableStream through a represented Node Transform one chunk at a time, waits for each _transform callback, returns the destination, and invokes the completion callback with undefined or the observed error.",
        &["tests/corpus/5451-stream-pipeline/main.ts"],
    )];
    entries.extend([
        ("isDisturbed", "stream.isDisturbed", Type::Bool),
        ("isErrored", "stream.isErrored", Type::Bool),
        ("isReadable", "stream.isReadable", Type::Dyn),
        ("isDestroyed", "stream.isDestroyed", Type::Dyn),
    ]
    .into_iter()
    .map(|(member, ir, result)| {
        Api::native(
            "stream",
            member,
            Lowering::Direct,
            vec![Builtin {
                ir,
                args: vec![Type::Dyn],
                result,
                implementation: Implementation::Emitter("values"),
            }],
            "Native stream state query for represented WHATWG byte streams; non-stream values report false",
            &["tests/corpus/5359-stream-state-queries/main.ts"],
        )
    }));
    entries
}
