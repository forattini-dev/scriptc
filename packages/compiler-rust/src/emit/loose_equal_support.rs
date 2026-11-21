fn native_value_abstract_primitive(value: &NativeValue) -> bool {
    matches!(
        value,
        NativeValue::Undefined
            | NativeValue::Null
            | NativeValue::Number(_)
            | NativeValue::BigInt(_)
            | NativeValue::Boolean(_)
            | NativeValue::String(_)
            | NativeValue::Symbol(_)
    )
}

fn native_value_abstract_eq(left: &NativeValue, right: &NativeValue) -> bool {
    if native_value_eq(left, right) {
        return true;
    }
    match (left, right) {
        (NativeValue::Undefined, NativeValue::Null)
        | (NativeValue::Null, NativeValue::Undefined) => true,
        (NativeValue::Number(left), NativeValue::String(right)) => {
            *left == runtime::number_from_string(right)
        }
        (NativeValue::String(left), NativeValue::Number(right)) => {
            runtime::number_from_string(left) == *right
        }
        (NativeValue::BigInt(left), NativeValue::String(right)) => {
            runtime::bigint_eq_string(left, right)
        }
        (NativeValue::String(left), NativeValue::BigInt(right)) => {
            runtime::bigint_eq_string(right, left)
        }
        (NativeValue::BigInt(left), NativeValue::Number(right)) => {
            runtime::bigint_cmp_number(left, *right) == Some(std::cmp::Ordering::Equal)
        }
        (NativeValue::Number(left), NativeValue::BigInt(right)) => {
            runtime::bigint_cmp_number(right, *left) == Some(std::cmp::Ordering::Equal)
        }
        (NativeValue::Boolean(left), right) => native_value_abstract_eq(
            &NativeValue::Number(if *left { 1.0 } else { 0.0 }),
            right,
        ),
        (left, NativeValue::Boolean(right)) => native_value_abstract_eq(
            left,
            &NativeValue::Number(if *right { 1.0 } else { 0.0 }),
        ),
        (left, right)
            if native_value_abstract_primitive(left) != native_value_abstract_primitive(right) =>
        {
            runtime::throw_type_error(
                "scriptc: abstract equality object ToPrimitive is not ported".into(),
            )
        }
        _ => false,
    }
}
