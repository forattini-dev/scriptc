use super::*;

pub(super) fn apis() -> Vec<Api> {
    [
        ("fromCharCode", "string.fromCharCode", "string_from_char_codes"),
        ("fromCodePoint", "string.fromCodePoint", "string_from_code_points"),
    ]
    .into_iter()
    .map(|(member, ir, runtime)| Api::native(
        "String", member, Lowering::Primitive,
        vec![Builtin {
            ir,
            args: vec![Type::Array { elem: Box::new(Type::F64) }],
            result: Type::String,
            implementation: Implementation::Runtime(runtime),
        }],
        "Declaration-proven direct calls and method-value aliases; evaluate all ordinary arguments before strict primitive ToNumber conversion; preserve UTF-16 units and per-code-point validation order; object coercion hooks and iterable spreads are not admitted by this lowering",
        &[
            "tests/corpus/rust-native-string-construction/values.ts",
            "tests/corpus/rust-native-string-construction/errors.ts",
            "tests/corpus/rust-native-string-construction/order.ts",
            "tests/corpus/rust-native-string-construction/shadowing.ts",
        ],
    ))
    .collect()
}

pub(super) fn internal() -> Vec<Builtin> {
    vec![call!(
        "string.iterArray",
        [Type::String],
        Type::Array {
            elem: Box::new(Type::String)
        },
        "string_iteration_array"
    )]
}
