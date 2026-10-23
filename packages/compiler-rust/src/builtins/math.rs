use super::*;
macro_rules! float_call {
    ($method:literal) => {
        float_call!($method, $method)
    };
    ($member:literal, $method:literal) => {
        Builtin {
            ir: concat!("math.", $member),
            args: vec![Type::F64],
            result: Type::F64,
            implementation: Implementation::FloatMethod($method),
        }
    };
}
pub(super) fn apis() -> Vec<Api> {
    let operations = vec![
        float_call!("floor"),
        float_call!("ceil"),
        float_call!("trunc"),
        float_call!("sqrt"),
        float_call!("cbrt"),
        float_call!("log", "ln"),
        float_call!("log2"),
        float_call!("log10"),
        float_call!("exp"),
        float_call!("sin"),
        float_call!("cos"),
        float_call!("tan"),
        float_call!("asin"),
        float_call!("acos"),
        float_call!("atan"),
        Builtin {
            ir: "math.atan2",
            args: vec![Type::F64, Type::F64],
            result: Type::F64,
            implementation: Implementation::FloatBinaryMethod("atan2"),
        },
        call!("math.pow", [Type::F64, Type::F64], Type::F64, "math_pow"),
        call!(
            "math.hypotArr",
            [Type::Array {
                elem: Box::new(Type::F64)
            }],
            Type::F64,
            "math_hypot_array"
        ),
        call!("math.round", [Type::F64], Type::F64, "math_round"),
        float_call!("abs"),
        call!("math.sign", [Type::F64], Type::F64, "math_sign"),
        call!(
            "math.minArr",
            [Type::Array {
                elem: Box::new(Type::F64)
            }],
            Type::F64,
            "math_min_array"
        ),
        call!(
            "math.maxArr",
            [Type::Array {
                elem: Box::new(Type::F64)
            }],
            Type::F64,
            "math_max_array"
        ),
    ];
    operations.into_iter().map(|op| {
        let name = op.ir.strip_prefix("math.").unwrap().trim_end_matches("Arr");
        Api::native("Math", name, Lowering::Primitive, vec![op],
            "Declaration-proven Math methods; eager primitive conversions and argument effects; object coercion and iterable spreads refused",
            &["tests/corpus/rust-native-primitives/math.ts", "tests/corpus/rust-native-primitives/math-functions.ts"])
    }).collect()
}
pub(super) fn internal() -> Vec<Builtin> {
    vec![call!(
        "num.fromString",
        [String],
        Type::F64,
        "number_from_string"
    )]
}
