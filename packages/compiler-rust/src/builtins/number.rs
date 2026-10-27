use super::*;

pub(super) fn apis() -> Vec<Api> {
    let mut apis = vec![Api::native(
        "Number.prototype",
        "toString",
        Lowering::Primitive,
        vec![call!(
            "num.toRadixString",
            [Type::F64, Type::F64],
            Type::String,
            "number_to_radix_string"
        )],
        "Declaration-proven numeric receiver; eager ordinary argument evaluation; default radix 10 and represented primitive radix coercions; boxed receivers, object coercion hooks and iterable spreads refused",
        &[
            "tests/corpus/rust-native-number-string/contracts.ts",
            "tests/corpus/rust-native-number-string/order.ts",
            "tests/corpus/rust-native-number-string/errors.ts",
        ],
    )];
    apis.push(Api::native(
        "Number.prototype", "toFixed", Lowering::Primitive,
        vec![call!("num.toFixed", [Type::F64, Type::F64], Type::String, "number_to_fixed")],
        "Declaration-proven numeric receiver; eager ordinary arguments before primitive digits conversion; omitted/undefined digits default to zero; boxed receivers, object coercion hooks and iterable spreads refused",
        &["tests/corpus/rust-native-number-fixed/values.ts", "tests/corpus/rust-native-number-fixed/order.ts", "tests/corpus/rust-native-number-fixed/errors.ts"],
    ));
    for (name, operation) in [
        (
            "parseInt",
            call!(
                "num.parseInt",
                [Type::String, Type::F64],
                Type::F64,
                "number_parse_int"
            ),
        ),
        (
            "parseFloat",
            call!(
                "num.parseFloat",
                [Type::String],
                Type::F64,
                "number_parse_float"
            ),
        ),
    ] {
        for module in ["Number", "global"] {
            apis.push(Api::native(module, name, Lowering::Primitive, vec![operation.clone()],
                "Declaration-proven parser values; global and Number members share identity; eager ordinary arguments followed by primitive ToString and ToNumber(radix); missing input is undefined; object coercion hooks and iterable spreads refused",
                &["tests/corpus/rust-native-number-parsers/values.ts", "tests/corpus/rust-native-number-parsers/aliases.ts", "tests/corpus/rust-native-number-parsers/order.ts", "tests/corpus/rust-native-number-parsers/grammar.ts", "tests/corpus/rust-native-number-parsers/errors.ts"]));
        }
    }
    for (name, operation) in [
        (
            "isFinite",
            Builtin {
                ir: "number.isFinite",
                args: vec![Type::F64],
                result: Type::Bool,
                implementation: Implementation::FloatMethod("is_finite"),
            },
        ),
        (
            "isNaN",
            Builtin {
                ir: "number.isNaN",
                args: vec![Type::F64],
                result: Type::Bool,
                implementation: Implementation::FloatMethod("is_nan"),
            },
        ),
        (
            "isInteger",
            call!(
                "number.isInteger",
                [Type::F64],
                Type::Bool,
                "number_is_integer"
            ),
        ),
        (
            "isSafeInteger",
            call!(
                "number.isSafeInteger",
                [Type::F64],
                Type::Bool,
                "number_is_safe_integer"
            ),
        ),
    ] {
        apis.push(Api::native("Number", name, Lowering::Primitive, vec![operation],
            "Declaration-proven Number predicate; original tag inspected without coercion; missing input is undefined, extra ordinary arguments evaluate; callable aliases keep native identity",
            &["tests/corpus/rust-native-number-predicates/values.ts", "tests/corpus/rust-native-number-predicates/order.ts", "tests/corpus/rust-native-number-predicates/aliases.ts"]));
    }
    apis
}
