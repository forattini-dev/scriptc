// The method is an intrinsic function value, so aliases and Function.call
// retain their receiver and the result is a fresh dynamic array.
fn native_string_split(receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    if matches!(receiver, NativeValue::Undefined | NativeValue::Null) {
        runtime::throw_type_error("String.prototype.split called on null or undefined".into());
    }
    let separator = args.first().cloned().unwrap_or(NativeValue::Undefined);
    let limit_value = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
    if matches!(separator, NativeValue::Object(_) | NativeValue::Record(..)) {
        let method = native_value_symbol_get(separator.clone(), runtime::symbol_well_known(runtime::WellKnownSymbol::Split));
        if !matches!(method, NativeValue::Undefined | NativeValue::Null) {
            if !native_value_is_function(&method) {
                runtime::throw_type_error("@@split is not callable".into());
            }
            return native_value_call_with_this(method, separator, vec![receiver, limit_value], "Symbol.split");
        }
    }
    let subject = native_value_string(receiver);
    let limit = if matches!(limit_value, NativeValue::Undefined) {
        u32::MAX as f64
    } else {
        native_compare_number(&limit_value)
    };
    if runtime::to_uint32(limit) == 0 {
        return NativeValue::Array(runtime::array_new(Vec::new()));
    }
    if matches!(separator, NativeValue::Undefined) {
        return NativeValue::Array(runtime::array_new(vec![NativeValue::String(subject)]));
    }
    let parts = match separator {
        NativeValue::Regex(regex) => runtime::regex_split(&subject, &regex, limit),
        other => runtime::string_split(&subject, &native_value_string(other), limit),
    };
    NativeValue::Array(runtime::array_new((0..runtime::array_len(&parts) as usize)
        .map(|index| NativeValue::String(runtime::array_get(&parts, index as f64)))
        .collect()))
}

// Contextually typed JavaScript callbacks can erase a statically known string
// before this call reaches the backend. Keep that dynamic ABI on the same
// native RegExp implementation as the typed String.prototype.match intrinsic.
fn native_string_match(receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    if matches!(receiver, NativeValue::Undefined | NativeValue::Null) {
        runtime::throw_type_error("String.prototype.match called on null or undefined".into());
    }
    let argument = args.first().cloned().unwrap_or(NativeValue::Undefined);
    if matches!(&argument, NativeValue::Object(_) | NativeValue::Record(..) | NativeValue::Callable(_)) {
        let method = native_value_symbol_get(argument.clone(), runtime::symbol_well_known(runtime::WellKnownSymbol::Match));
        if !matches!(method, NativeValue::Undefined | NativeValue::Null) {
            if !native_value_is_function(&method) {
                runtime::throw_type_error("@@match is not callable".into());
            }
            return native_value_call_with_this(method, argument, vec![receiver], "Symbol.match");
        }
    }
    let subject = native_value_string(receiver);
    let regex = match argument {
        NativeValue::Regex(regex) => regex,
        NativeValue::Undefined => runtime::regex_new("", ""),
        other => runtime::regex_new(&native_value_string(other), ""),
    };
    match runtime::regex_match(&subject, &regex, |value| {
        value
            .map(NativeValue::String)
            .unwrap_or(NativeValue::Undefined)
    }) {
        Some(row) => NativeValue::Array(row),
        None => NativeValue::Null,
    }
}

fn native_string_starts_with(receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    if matches!(receiver, NativeValue::Undefined | NativeValue::Null) {
        runtime::throw_type_error("String.prototype.startsWith called on null or undefined".into());
    }
    let subject = native_value_string(receiver);
    let search = native_value_string(args.first().cloned().unwrap_or(NativeValue::Undefined));
    let position = args.get(1).map(native_compare_number).unwrap_or(0.0);
    NativeValue::Boolean(runtime::string_starts_with(&subject, &search, position))
}

fn native_string_slice(receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    if matches!(receiver, NativeValue::Undefined | NativeValue::Null) {
        runtime::throw_type_error("String.prototype.slice called on null or undefined".into());
    }
    let subject = native_value_string(receiver);
    let start = args.first().map(native_compare_number).unwrap_or(0.0);
    let end = args
        .get(1)
        .map(native_compare_number)
        .unwrap_or(f64::INFINITY);
    NativeValue::String(runtime::string_slice(&subject, start, end))
}

fn native_string_simple(method: u8, receiver: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    if matches!(receiver, NativeValue::Undefined | NativeValue::Null) {
        runtime::throw_type_error("String prototype method called on null or undefined".into());
    }
    let subject = native_value_string(receiver);
    let number = |index: usize, default: f64| {
        args.get(index).map(native_compare_number).unwrap_or(default)
    };
    let text = |index: usize, default: &str| {
        args.get(index)
            .cloned()
            .map(native_value_string)
            .unwrap_or_else(|| runtime::string(default))
    };
    match method {
        3 => NativeValue::Boolean(runtime::string_includes(
            &subject,
            &text(0, "undefined"),
            number(1, 0.0),
        )),
        4 => NativeValue::Boolean(runtime::string_ends_with(
            &subject,
            &text(0, "undefined"),
            number(1, f64::INFINITY),
        )),
        5 => NativeValue::String(runtime::string_trim(&subject)),
        6 => NativeValue::String(runtime::string_trim_start(&subject)),
        7 => NativeValue::String(runtime::string_trim_end(&subject)),
        8 => NativeValue::String(runtime::string_to_lower_case(&subject)),
        9 => NativeValue::String(runtime::string_to_upper_case(&subject)),
        10 => NativeValue::String(runtime::string_substring(
            &subject,
            number(0, 0.0),
            number(1, f64::INFINITY),
        )),
        11 => NativeValue::String(runtime::string_substr(
            &subject,
            number(0, 0.0),
            number(1, f64::INFINITY),
        )),
        12 => NativeValue::String(runtime::string_repeat(&subject, number(0, f64::NAN))),
        13 => NativeValue::String(runtime::string_char_at(&subject, number(0, 0.0))),
        14 => NativeValue::Number(runtime::string_char_code_at(&subject, number(0, 0.0))),
        15 => NativeValue::Number(runtime::string_code_point_at(&subject, number(0, 0.0))),
        16 => NativeValue::Number(runtime::string_index_of(
            &subject,
            &text(0, "undefined"),
            number(1, 0.0),
        )),
        17 => NativeValue::Number(runtime::string_last_index_of(
            &subject,
            &text(0, "undefined"),
            number(1, f64::INFINITY),
        )),
        18 => NativeValue::Number(runtime::string_locale_compare(
            &subject,
            &text(0, "undefined"),
        )),
        19 => NativeValue::Boolean(runtime::string_is_well_formed(&subject)),
        20 => NativeValue::String(runtime::string_to_well_formed(&subject)),
        21 => NativeValue::String(runtime::string_pad_start(
            &subject,
            number(0, 0.0),
            &text(1, " "),
        )),
        22 => NativeValue::String(runtime::string_pad_end(
            &subject,
            number(0, 0.0),
            &text(1, " "),
        )),
        24 => NativeValue::String(runtime::string_to_lower_case(&subject)),
        25 => NativeValue::String(runtime::string_to_upper_case(&subject)),
        _ => unreachable!("validated simple string method"),
    }
}
