//! The existing IR v13 BigInt library ABI, shared by validation and emission.
use super::Type;

pub(crate) fn signature(name: &str) -> Option<(Vec<Type>, Type, &'static str)> {
    use Type::{Bigint as B, Bool, F64, String as S};
    let (args, result, runtime) = match name.strip_prefix("bigint.")? {
        "parse" | "fromString" => (vec![S], B, "bigint_from_string"),
        "fromF64" | "fromNumber" => (vec![F64], B, "bigint_from_number"),
        "fromBool" => (vec![Bool], B, "bigint_from_bool"),
        "toString" => (vec![B], S, "bigint_to_string"),
        "radix" => (vec![B, F64], S, "bigint_to_string_radix"),
        "inspect" => (vec![B], S, "bigint_inspect"),
        "truthy" => (vec![B], Bool, "bigint_truthy"),
        "toF64" | "toNumber" => (vec![B], F64, "bigint_to_number"),
        "neg" => (vec![B], B, "bigint_neg"),
        "not" => (vec![B], B, "bigint_not"),
        "add" => (vec![B, B], B, "bigint_add"),
        "sub" => (vec![B, B], B, "bigint_sub"),
        "mul" => (vec![B, B], B, "bigint_mul"),
        "div" => (vec![B, B], B, "bigint_div"),
        "mod" | "rem" => (vec![B, B], B, "bigint_rem"),
        "pow" => (vec![B, B], B, "bigint_pow"),
        "and" => (vec![B, B], B, "bigint_and"),
        "or" => (vec![B, B], B, "bigint_or"),
        "xor" => (vec![B, B], B, "bigint_xor"),
        "shl" => (vec![B, B], B, "bigint_shl"),
        "shr" => (vec![B, B], B, "bigint_shr"),
        "eq" => (vec![B, B], Bool, "bigint_eq"),
        "eqString" => (vec![B, S], Bool, "bigint_eq_string"),
        "asIntN" => (vec![F64, B], B, "bigint_as_int_n"),
        "asUintN" => (vec![F64, B], B, "bigint_as_uint_n"),
        _ => return None,
    };
    Some((args, result, runtime))
}
