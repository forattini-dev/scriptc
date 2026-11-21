thread_local! {
    static NATIVE_JOIN_ACTIVE: std::cell::RefCell<Vec<usize>> = const { std::cell::RefCell::new(Vec::new()) };
}
struct NativeJoinGuard(usize);
impl Drop for NativeJoinGuard {
    fn drop(&mut self) {
        NATIVE_JOIN_ACTIVE.with(|active| {
            let mut active = active.borrow_mut();
            if let Some(position) = active.iter().rposition(|id| *id == self.0) {
                active.remove(position);
            }
        });
    }
}
fn native_join_guard(value: &NativeValue) -> Result<Option<NativeJoinGuard>, ()> {
    let Some(id) = native_array_identity(value) else {
        return Ok(None);
    };
    NATIVE_JOIN_ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        if active.contains(&id) {
            return Err(());
        }
        active.push(id);
        Ok(Some(NativeJoinGuard(id)))
    })
}

// The original receiver is retained when a prototype getter is invoked.
fn native_join_property(
    current: NativeValue,
    receiver: &NativeValue,
    key: &runtime::JsString,
) -> Option<NativeValue> {
    if let NativeValue::Proxy(proxy) = current {
        return Some(native_proxy_get(
            &proxy,
            NativeValue::String(key.clone()),
            receiver.clone(),
        ));
    }
    let object = match &current {
        NativeValue::Object(object) | NativeValue::Record(_, object) => object.clone(),
        NativeValue::Null => return None,
        _ => runtime::throw_type_error(
            "scriptc: object string conversion prototype is not supported yet".into(),
        ),
    };
    if let Some(value) = native_getter_read_with_receiver(&current, key, receiver.clone()) {
        return Some(value);
    }
    if let Some(value) = object.with(|data| {
        data.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }) {
        return Some(value);
    }
    if let Some(prototype) = native_instance_prototype(&object) {
        return native_join_property(prototype, receiver, key);
    }
    if !object.with(|data| data.null_prototype) {
        return native_join_property(native_object_prototype_value(), receiver, key);
    }
    None
}

fn native_join_symbol(
    current: NativeValue,
    receiver: &NativeValue,
    key: &runtime::JsSymbol,
) -> Option<NativeValue> {
    if let NativeValue::Proxy(proxy) = current {
        return Some(native_proxy_get(
            &proxy,
            NativeValue::Symbol(key.clone()),
            receiver.clone(),
        ));
    }
    let object = match &current {
        NativeValue::Object(object) | NativeValue::Record(_, object) => object.clone(),
        NativeValue::Null => return None,
        _ => runtime::throw_type_error(
            "scriptc: object string conversion prototype is not supported yet".into(),
        ),
    };
    if let Some(value) = object.with(|data| {
        data.symbol_properties
            .as_ref()
            .and_then(|table| table.get(&runtime::PropertyKey::Symbol(key.clone())))
            .map(|property| property.value.clone())
    }) {
        return Some(value);
    }
    if let Some(prototype) = native_instance_prototype(&object) {
        return native_join_symbol(prototype, receiver, key);
    }
    if !object.with(|data| data.null_prototype) {
        return native_join_symbol(native_object_prototype_value(), receiver, key);
    }
    None
}

// String conversion for ordinary object elements of Array.prototype.join.
fn native_join_element_string(value: NativeValue) -> runtime::JsString {
    if native_value_is_array(&value) {
        return native_value_string(native_array_to_string(value));
    }
    match &value {
        NativeValue::Object(_) | NativeValue::Record(_, _) | NativeValue::Proxy(_) => (),
        _ => return native_value_string(value),
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
            vec![NativeValue::String(runtime::string("string"))],
            "Symbol.toPrimitive",
        );
        if !primitive(&result) {
            runtime::throw_type_error("Cannot convert object to primitive value".into());
        }
        return native_value_string(result);
    }
    for name in ["toString", "valueOf"] {
        let key = runtime::string(name);
        let method =
            native_join_property(value.clone(), &value, &key).unwrap_or(NativeValue::Undefined);
        if native_value_is_function(&method) {
            let result = native_value_call_with_this(method, value.clone(), Vec::new(), name);
            if primitive(&result) {
                return native_value_string(result);
            }
        }
    }
    runtime::throw_type_error("Cannot convert object to primitive value".into())
}
