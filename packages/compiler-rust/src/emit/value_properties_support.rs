// Ordinary function data slots deliberately exclude intrinsic descriptors and prototypes.
fn native_global_unescape_value() -> NativeValue {
    let global = native_global_object();
    let key = runtime::string("unescape");
    if !native_value_has_own(global.clone(), key.clone()) {
        runtime::throw_reference_error("unescape is not defined".into());
    }
    native_value_get(global, key)
}
fn native_legacy_unescape(args: Vec<NativeValue>) -> NativeValue {
    let first = args.into_iter().next().unwrap_or(NativeValue::Undefined);
    NativeValue::String(runtime::string_unescape(&native_value_string(first)))
}

fn native_function_data_key(key: &runtime::JsString) {
    if matches!(key.well_formed_utf8(), Some("name" | "length" | "bind" | "call" | "apply" | "caller" | "arguments" | "constructor" | "__proto__" | "toString" | "valueOf" | "hasOwnProperty" | "isPrototypeOf" | "propertyIsEnumerable" | "toLocaleString")) {
        runtime::throw_type_error("scriptc: intrinsic function properties require their native member contract".into());
    }
}
// Owning property operations shared by dot and computed writes.
/// Read `key` from `prototype` on behalf of `receiver`, so inherited
/// accessors observe the original object as `this`.
fn native_prototype_get(
    prototype: NativeValue,
    key: &runtime::JsString,
    receiver: NativeValue,
) -> NativeValue {
    if let Some(found) = native_getter_read_with_receiver(&prototype, key, receiver.clone()) {
        return found;
    }
    if let NativeValue::Object(object) = &prototype {
        if let Some(found) = object.with(|o| {
            o.entries
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        }) {
            return found;
        }
        if let Some(next) = native_instance_prototype(object) {
            return native_prototype_get(next, key, receiver);
        }
    }
    native_value_get(prototype, key.clone())
}

fn native_value_set(value: NativeValue, key: runtime::JsString, field: NativeValue) {
    if native_net_socket_property(&value, &key).is_some() {
        runtime::throw_error_code(
            "scriptc: assigning socket state properties is not supported yet".into(),
            "SC1031",
        );
    }
    if let NativeValue::Proxy(proxy) = &value {
        if !native_proxy_set(
            proxy,
            NativeValue::String(key),
            field,
            value.clone(),
        ) {
            runtime::throw_type_error("Proxy set trap returned false".into());
        }
        return;
    }
    if native_getter_write(&value, &key, field.clone()) {
        return;
    }
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
    // [[Set]] on an ordinary object without an own property consults its
    // prototype chain: an inherited accessor runs its setter on the original
    // receiver and an inherited read-only data property rejects the write.
    if let NativeValue::Object(object) = &value
        && !object.with(|o| o.entries.iter().any(|(k, _)| *k == key))
    {
        let mut next = native_instance_prototype(object);
        while let Some(prototype) = next {
            match native_getter_lookup(&prototype, &key) {
                Some(runtime::OrdinaryProperty::Accessor(_)) => {
                    native_getter_write_with_receiver(&prototype, &key, field, value.clone());
                    return;
                }
                Some(runtime::OrdinaryProperty::Data(property)) => {
                    if !property.writable {
                        runtime::throw_type_error(format!(
                            "Cannot assign to read only property '{}' of object",
                            key
                        ));
                    }
                    break;
                }
                None => {}
            }
            next = match &prototype {
                NativeValue::Object(parent)
                    if !parent.with(|o| o.entries.iter().any(|(k, _)| *k == key)) =>
                {
                    native_instance_prototype(parent)
                }
                _ => None,
            };
        }
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
                    runtime::array_property_set(&array, key, field);
                }
            } else {
                runtime::array_property_set(&array, key, field);
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
    if key == "length" && native_value_is_array(&value) { return true; }
    if key == "raw" && native_array_own_descriptor(&value, &key).is_some() { return true; }
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
                || runtime::array_property_has(array, &key)
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
fn native_value_has_own_key(value: NativeValue, key: NativeValue) -> bool {
    match key {
        NativeValue::Symbol(_) => native_value_has_own_symbol_key(value, key),
        NativeValue::String(key) => native_value_has_own(value, key),
        key @ (NativeValue::Undefined
        | NativeValue::Null
        | NativeValue::Number(_)
        | NativeValue::BigInt(_)
        | NativeValue::Boolean(_)) => native_value_has_own(value, native_value_string(key)),
        _ => runtime::throw_type_error(
            "scriptc: object property keys with ToPrimitive hooks are not ported".into(),
        ),
    }
}
fn native_array_index_keys<T: runtime::ArrayElement>(array: &runtime::JsArray<T>) -> Vec<runtime::JsString> {
    let mut keys = runtime::array_own_index_keys(array);
    keys.extend(runtime::array_property_keys(array));
    keys
}
fn native_index_keys(length: usize) -> Vec<runtime::JsString> {
    (0..length).map(|index| index.to_string().into()).collect()
}

// Object.assign snapshots every own key before invoking any getter, then
// checks the current descriptor immediately before reading each property.
fn native_object_assign_copy(target: NativeValue, source: NativeValue) {
    if matches!(target, NativeValue::Null | NativeValue::Undefined) {
        runtime::throw_type_error("Cannot convert undefined or null to object".into());
    }
    if matches!(source, NativeValue::Null | NativeValue::Undefined) {
        return;
    }
    let mut keys = match &source {
        NativeValue::Number(_) | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::Symbol(_) => Vec::new(),
        NativeValue::String(text) => native_index_keys(text.encode_utf16().count()),
        _ => native_value_own_keys(&source),
    };
    keys.sort_by_key(|key| key.parse::<u32>().ok().filter(|index| *index != u32::MAX && *key == index.to_string()).map(|index| (0, index)).unwrap_or((1, 0)));
    let symbols = native_value_own_symbols(&source);
    for key in keys {
        let exists = native_getter_lookup(&source, &key).is_some()
            || native_value_has_own(source.clone(), key.clone());
        if exists && native_getter_enumerable(&source, &key) {
            let field = native_value_get(source.clone(), key.clone());
            native_value_set(target.clone(), key, field);
        }
    }
    for key in symbols {
        if native_value_own_symbol_property(&source, &key).is_some_and(|property| property.enumerable) {
            let field = native_value_symbol_get(source.clone(), key.clone());
            native_value_symbol_set(target.clone(), key, field);
        }
    }
}
