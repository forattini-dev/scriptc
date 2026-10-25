use super::*;

pub(super) fn apis() -> Vec<Api> {
    vec![Api::native(
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
    )]
}
