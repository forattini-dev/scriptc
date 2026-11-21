// Relational comparison first obtains primitive values with the number hint.
// Ordinary objects keep their original receiver for getters and method calls.
fn native_compare_primitive(value: NativeValue) -> NativeValue {
    if !matches!(
        &value,
        NativeValue::Object(_) | NativeValue::Record(_, _) | NativeValue::Proxy(_)
    ) {
        return value;
    }
    let primitive = |candidate: &NativeValue| {
        matches!(
            candidate,
            NativeValue::Undefined
                | NativeValue::Null
                | NativeValue::Boolean(_)
                | NativeValue::Number(_)
                | NativeValue::String(_)
                | NativeValue::BigInt(_)
                | NativeValue::Symbol(_)
        )
    };
    let exotic = native_join_symbol(
        value.clone(),
        &value,
        &runtime::symbol_well_known(runtime::WellKnownSymbol::ToPrimitive),
    )
    .unwrap_or(NativeValue::Undefined);
    if !matches!(exotic, NativeValue::Undefined | NativeValue::Null) {
        if !native_value_is_function(&exotic) {
            runtime::throw_type_error("Cannot convert object to primitive value".into());
        }
        let result = native_value_call_with_this(
            exotic,
            value.clone(),
            vec![NativeValue::String(runtime::string("number"))],
            "Symbol.toPrimitive",
        );
        if !primitive(&result) {
            runtime::throw_type_error("Cannot convert object to primitive value".into());
        }
        return result;
    }
    for name in ["valueOf", "toString"] {
        let key = runtime::string(name);
        let method =
            native_join_property(value.clone(), &value, &key).unwrap_or(NativeValue::Undefined);
        if native_value_is_function(&method) {
            let result = native_value_call_with_this(method, value.clone(), Vec::new(), name);
            if primitive(&result) {
                return result;
            }
        }
    }
    runtime::throw_type_error("Cannot convert object to primitive value".into())
}

// Shared IR dyn.compare contract for represented primitive native values.
fn native_compare_number(value: &NativeValue) -> f64 {
    match value {
        NativeValue::Number(value) => *value,
        NativeValue::String(value) => runtime::number_from_string(value),
        NativeValue::Boolean(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        NativeValue::Null => 0.0,
        NativeValue::Undefined => f64::NAN,
        NativeValue::BigInt(_) => {
            runtime::throw_type_error("Cannot convert a BigInt value to a number".into())
        }
        NativeValue::Symbol(_) => {
            runtime::throw_type_error("Cannot convert a Symbol value to a number".into())
        }
        _ => runtime::throw_type_error(
            "scriptc: relational object coercion requires native ToPrimitive support".into(),
        ),
    }
}

fn native_value_compare(left: NativeValue, right: NativeValue) -> f64 {
    let left = native_compare_primitive(left);
    let right = native_compare_primitive(right);
    let order = match (&left, &right) {
        (NativeValue::String(left), NativeValue::String(right)) => Some(left.cmp(right)),
        (NativeValue::BigInt(left), NativeValue::BigInt(right)) => Some(left.cmp(right)),
        (NativeValue::BigInt(left), NativeValue::String(right)) => {
            runtime::bigint_parse(right).map(|right| left.cmp(&right))
        }
        (NativeValue::String(left), NativeValue::BigInt(right)) => {
            runtime::bigint_parse(left).map(|left| left.cmp(right))
        }
        (NativeValue::BigInt(left), right) => {
            runtime::bigint_cmp_number(left, native_compare_number(right))
        }
        (left, NativeValue::BigInt(right)) => {
            runtime::bigint_cmp_number(right, native_compare_number(left))
                .map(std::cmp::Ordering::reverse)
        }
        _ => {
            // Converting the left to NaN must not skip conversion of the right:
            // the right may be a Symbol and still needs to throw.
            let left = native_compare_number(&left);
            let right = native_compare_number(&right);
            left.partial_cmp(&right)
        }
    };
    match order {
        Some(std::cmp::Ordering::Less) => -1.0,
        Some(std::cmp::Ordering::Equal) => 0.0,
        Some(std::cmp::Ordering::Greater) => 1.0,
        None => f64::NAN,
    }
}
