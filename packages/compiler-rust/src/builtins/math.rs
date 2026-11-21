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
        call!("math.random", [], Type::F64, "math_random"),
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
        call!("math.imul", [Type::F64, Type::F64], Type::F64, "math_imul"),
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
    let mut entries: Vec<Api> = operations.into_iter().map(|op| {
        let name = op.ir.strip_prefix("math.").unwrap().trim_end_matches("Arr");
        Api::native("Math", name, Lowering::Primitive, vec![op],
            "Declaration-proven Math methods; eager primitive conversions and argument effects; object coercion and iterable spreads refused",
            &["tests/corpus/rust-native-primitives/math.ts", "tests/corpus/rust-native-primitives/math-functions.ts"])
    }).collect();
    entries.push(Api::native(
        "Date",
        "now",
        Lowering::Primitive,
        vec![call!("date.now", [], Type::F64, "date_now")],
        "Declaration-proven zero-argument Date.now, including its ordinary zero-argument function-value view",
        &[
            "tests/corpus/rust-native-platform/open-numeric.ts",
            "tests/corpus/rust-native-platform/date-now-value.ts",
        ],
    ));
    entries.push(Api::native(
        "performance",
        "now",
        Lowering::Primitive,
        vec![call!("performance.now", [], Type::F64, "performance_now")],
        "Declaration-proven zero-argument global performance.now backed by the native monotonic process clock",
        &["tests/corpus/5201-performance-now.ts"],
    ));
    entries.push(Api::native(
        "Date",
        "UTC",
        Lowering::Primitive,
        vec![call!(
            "date.utc",
            [
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64
            ],
            Type::F64,
            "date_utc"
        )],
        "Declaration-proven Date.UTC with numeric components",
        &["tests/corpus/rust-native-platform/date-value.ts"],
    ));
    entries.push(Api::native(
        "Date",
        "parse",
        Lowering::Primitive,
        vec![call!(
            "date.parseString",
            [Type::String],
            Type::F64,
            "date_parse_get_time"
        )],
        "Declaration-proven Date.parse with one represented string argument, including its ordinary single-argument function-value view",
        &[
            "tests/corpus/5052-date-parse-static.ts",
            "tests/corpus/rust-native-platform/date-parse-value.ts",
        ],
    ));
    entries
}
pub(super) fn internal() -> Vec<Builtin> {
    vec![
        call!("num.fromString", [String], Type::F64, "number_from_string"),
        call!(
            "date.parseString",
            [String],
            Type::F64,
            "date_parse_get_time"
        ),
        call!("date.newValue", [Type::F64], Type::Dyn, "date_value_new"),
        call!("date.newDynamic", [Type::Dyn], Type::Dyn, "date_value_new"),
        call!(
            "date.newComponents",
            [
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64,
                Type::F64
            ],
            Type::F64,
            "date_new_components"
        ),
        Builtin {
            ir: "date.valueTime",
            args: vec![Type::Dyn],
            result: Type::F64,
            implementation: Implementation::Emitter("values"),
        },
    ]
}
