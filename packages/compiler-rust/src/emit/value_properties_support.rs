// Ordinary function data slots deliberately exclude intrinsic descriptors and prototypes.
fn native_function_data_key(key: &runtime::JsString) {
    if matches!(key.well_formed_utf8(), Some("name" | "length" | "bind" | "call" | "apply" | "prototype" | "caller" | "arguments" | "constructor" | "__proto__" | "toString" | "valueOf" | "hasOwnProperty" | "isPrototypeOf" | "propertyIsEnumerable" | "toLocaleString")) {
        runtime::throw_type_error("scriptc: intrinsic function properties require their native member contract".into());
    }
}
// Owning property operations shared by dot and computed writes.
fn native_value_set(value: NativeValue, key: runtime::JsString, field: NativeValue) {
    if key == "__proto__" && !matches!(&value, NativeValue::RawJson(_)) {
        runtime::throw_type_error("scriptc: ordinary prototype writes are not ported".into());
    }
    if key == "undefined" && let Some(owner) = native_bytes_property_key(&value) {
        runtime::weak_map_set(&owner, &owner, field);
        return;
    }
    if native_instance_property_set(&value, &key, &field) {
        return;
    }
    if let Some(properties) = native_function_properties(&value) {
        native_function_data_key(&key);
        native_record_set(&properties, key, field);
        return;
    }
    match value {
        NativeValue::RawJson(raw) => raw.refuse_write(&key),
        NativeValue::Object(object) => object.with_mut(|o| {
            if let Some((_, current)) = o.entries.iter_mut().find(|(k, _)| *k == key) {
                *current = field;
            } else {
                o.entries.push((key, field));
            }
        }),
        NativeValue::Array(array) => {
            if key == "length" {
                if let NativeValue::Number(length) = field {
                    runtime::array_set_length(&array, length);
                } else {
                    runtime::throw_type_error(
                        "scriptc: erased array length writes require a number".into(),
                    );
                }
            } else if let Ok(index) = key.parse::<u32>() {
                if index != u32::MAX && key == index.to_string() {
                    runtime::array_set(&array, index as f64, field);
                } else {
                    runtime::throw_type_error(
                        "scriptc: erased named array writes are not ported".into(),
                    );
                }
            } else {
                runtime::throw_type_error(
                    "scriptc: erased named array writes are not ported".into(),
                );
            }
        }
        NativeValue::Record(_, object) => {
            if key == "__proto__" {
                runtime::throw_type_error(
                    "scriptc: ordinary prototype writes are not ported".into(),
                );
            }
            native_record_set(&object, key, field);
        }
        _ => runtime::throw_type_error(
            "scriptc: property writes require a native plain object".into(),
        ),
    }
}
fn native_value_has_own(value: NativeValue, key: runtime::JsString) -> bool {
    if let Some(properties) = native_function_properties(&value) {
        native_function_data_key(&key);
        return properties.with(|data| data.entries.iter().any(|(name, _)| *name == key));
    }
    match &value {
        NativeValue::Undefined | NativeValue::Null => {
            runtime::throw_type_error("Cannot convert undefined or null to object".into())
        }
        NativeValue::Number(_)
        | NativeValue::BigInt(_)
        | NativeValue::Boolean(_)
        | NativeValue::Symbol(_) => return false,
        NativeValue::String(text) => {
            return key == "length"
                || key.parse::<usize>().ok().is_some_and(|index| {
                    key == index.to_string() && index < text.encode_utf16().count()
                });
        }
        NativeValue::Array(array) => {
            return key == "length"
                || key.parse::<u32>().ok().is_some_and(|index| {
                    index != u32::MAX
                        && key == index.to_string()
                        && runtime::array_has(array, index as f64)
                });
        }
        _ => {}
    }
    native_value_own_keys(&value).iter().any(|k| k == &key)
}
fn native_array_index_keys<T: runtime::ArrayElement>(array: &runtime::JsArray<T>) -> Vec<runtime::JsString> {
    runtime::array_own_index_keys(array)
}
fn native_index_keys(length: usize) -> Vec<runtime::JsString> {
    (0..length).map(|index| index.to_string().into()).collect()
}
