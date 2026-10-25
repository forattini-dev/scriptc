// Shared IR dyn.compare contract for represented primitive native values.
fn native_compare_number(value: &NativeValue) -> f64 {
    match value {
        NativeValue::Number(value) => *value,
        NativeValue::String(value) => runtime::number_from_string(value),
        NativeValue::Boolean(value) => if *value { 1.0 } else { 0.0 },
        NativeValue::Null => 0.0,
        NativeValue::Undefined => f64::NAN,
        NativeValue::Symbol(_) => runtime::throw_type_error("Cannot convert a Symbol value to a number".into()),
        _ => runtime::throw_type_error("scriptc: relational object coercion requires native ToPrimitive support".into()),
    }
}

fn native_value_compare(left: NativeValue, right: NativeValue) -> f64 {
    let order = if let (NativeValue::String(left), NativeValue::String(right)) = (&left, &right) {
        Some(left.cmp(right))
    } else {
        // Converting the left to NaN must not skip conversion of the right:
        // the right may be a Symbol and still needs to throw.
        let left = native_compare_number(&left);
        let right = native_compare_number(&right);
        left.partial_cmp(&right)
    };
    match order {
        Some(std::cmp::Ordering::Less) => -1.0,
        Some(std::cmp::Ordering::Equal) => 0.0,
        Some(std::cmp::Ordering::Greater) => 1.0,
        None => f64::NAN,
    }
}
