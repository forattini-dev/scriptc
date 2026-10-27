// Buffer.from over owning compiled values; no value tree or engine conversion.
fn native_buffer_element_number(value: NativeValue) -> f64 {
    match value {
        NativeValue::Number(value) => value,
        NativeValue::String(value) => runtime::number_from_string(&value),
        NativeValue::Boolean(value) => if value { 1.0 } else { 0.0 },
        NativeValue::Null => 0.0,
        NativeValue::Undefined => f64::NAN,
        NativeValue::BigInt(_) => runtime::throw_type_error("Cannot convert a BigInt value to a number".into()),
        NativeValue::Symbol(_) => runtime::throw_type_error("Cannot convert a Symbol value to a number".into()),
        _ => runtime::throw_type_error("scriptc: Buffer.from element object coercion hooks are not ported".into()),
    }
}

fn native_buffer_array_like(value: &NativeValue, length: f64) -> runtime::JsBytes<u8> {
    if length.is_nan() || length <= 0.0 { return runtime::buffer_alloc(0.0); }
    if length == f64::INFINITY { runtime::throw_range_error("Array buffer allocation failed".into()); }
    let result = runtime::buffer_alloc(length);
    for index in 0..runtime::bytes_len(&result) as usize {
        let item = native_value_get(value.clone(), runtime::string(&index.to_string()));
        runtime::bytes_set(&result, index as f64, native_buffer_element_number(item));
    }
    result
}

fn native_buffer_from_entry(value: NativeValue, encoding: &runtime::JsString) -> runtime::JsBytes<u8> {
    native_buffer_from(value, encoding.clone(), 0)
}

fn native_buffer_from(value: NativeValue, encoding: runtime::JsString, depth: usize) -> runtime::JsBytes<u8> {
    if depth > 128 { runtime::throw_error("scriptc: Buffer.from valueOf conversion beyond 128 levels is not supported yet".into()); }
    // Ordinary data objects have no observable inherited valueOf hook. Own
    // compiled hooks retain this and their original source/capture identity.
    if native_buffer_ordinary(&value) {
        let key = runtime::string("valueOf");
        if native_value_own_keys(&value).contains(&key) {
            let method = native_value_get(value.clone(), key);
            if native_value_test(&method, "truthy") {
                let result = native_value_call_with_this(method, value.clone(), vec![], "value.valueOf");
                if !native_value_eq(&result, &value) && !matches!(result, NativeValue::Null)
                    && (native_value_test(&result, "string") || native_value_test(&result, "object")) {
                    return native_buffer_from(result, encoding, depth + 1);
                }
            }
        }
    }
    if let NativeValue::String(text) = &value { return runtime::buffer_from_string(text, &encoding); }
    if let Some(bytes) = native_buffer_copy(&value) { return bytes; }
    if let Some(length) = native_buffer_array_length(&value) { return native_buffer_array_like(&value, length); }
    if native_buffer_ordinary(&value) {
        let length = native_value_get(value.clone(), runtime::string("length"));
        if !matches!(length, NativeValue::Undefined) {
            return if let NativeValue::Number(length) = length { native_buffer_array_like(&value, length) }
                else { runtime::buffer_alloc(0.0) };
        }
        let tag = native_value_get(value.clone(), runtime::string("type"));
        if matches!(tag, NativeValue::String(ref tag) if tag == "Buffer") {
            let data = native_value_get(value.clone(), runtime::string("data"));
            if let Some(length) = native_buffer_array_length(&data) { return native_buffer_array_like(&data, length); }
        }
    }
    let received = match &value {
        NativeValue::Undefined => "undefined".to_owned(),
        NativeValue::Null => "null".to_owned(),
        NativeValue::Number(number) => format!("type number ({})", if *number == 0.0 && number.is_sign_negative() { "-0".into() } else { js_string_number(*number) }),
        NativeValue::Boolean(value) => format!("type boolean ({value})"),
        NativeValue::BigInt(value) => format!("type bigint ({}n)", runtime::bigint_to_string(value)),
        NativeValue::Symbol(value) => format!("type symbol ({})", runtime::symbol_to_string(value)),
        _ if native_buffer_ordinary(&value) => "an instance of Object".into(),
        _ => runtime::throw_type_error("scriptc: Buffer.from source prototype protocol is not ported".into()),
    };
    runtime::throw_type_error_code(format!("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received {received}"), "ERR_INVALID_ARG_TYPE")
}
