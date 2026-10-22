// Native erased Map operations retain owning handles; no source execution.
fn native_value_same_key(a: &NativeValue, b: &NativeValue) -> bool {
    native_value_eq(a, b)
        || matches!((a,b), (NativeValue::Number(a), NativeValue::Number(b)) if a.is_nan() && b.is_nan())
}
fn native_map_key(key: NativeValue) -> NativeValue {
    match key {
        NativeValue::Number(n) if n == 0.0 => NativeValue::Number(0.0),
        key => key,
    }
}
fn native_value_method(recv: NativeValue, method: &str) -> NativeValue {
    if native_value_is_function(&recv) && matches!(method, "call" | "apply") { return recv; }
    if matches!(&recv, NativeValue::Promise(_)) && method == "then" {
        return recv;
    }
    if matches!(&recv, NativeValue::Map(_))
        && matches!(method, "get" | "set" | "has" | "delete" | "clear")
    {
        recv
    } else {
        native_value_get(recv, method.into())
    }
}
fn native_value_invoke(
    holder: NativeValue,
    recv: NativeValue,
    method: &str,
    args: Vec<NativeValue>,
    name: &str,
) -> NativeValue {
    if native_value_is_function(&holder) && matches!(method, "call" | "apply") {
        let receiver = args.first().cloned().unwrap_or(NativeValue::Undefined);
        let args = if method == "call" {
            args.into_iter().skip(1).collect()
        } else {
            match args.get(1) {
                None | Some(NativeValue::Null | NativeValue::Undefined) => vec![],
                Some(value) => native_value_apply_arguments(value),
            }
        };
        return native_value_call_with_this(holder, receiver, args, name);
    }
    if let NativeValue::Promise(promise) = recv {
        return NativeValue::Promise(native_promise_then(promise, args));
    }
    if let NativeValue::Map(map) = recv {
        let key = args.first().cloned().unwrap_or(NativeValue::Undefined);
        match method {
            "get" => {
                js_map_get(&map, &key, native_value_same_key).unwrap_or(NativeValue::Undefined)
            }
            "has" => NativeValue::Boolean(js_map_has(&map, &key, native_value_same_key)),
            "delete" => NativeValue::Boolean(js_map_delete(&map, &key, native_value_same_key)),
            "set" => {
                let value = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
                js_map_set(&map, native_map_key(key), value, native_value_same_key);
                NativeValue::Map(map)
            }
            "clear" => {
                map.with_mut(|m| m.entries.clear());
                NativeValue::Undefined
            }
            _ => runtime::throw_type_error(format!(
                "scriptc: native Map method {} is not supported yet",
                method
            )),
        }
    } else {
        native_value_call_with_this(recv, holder, args, name)
    }
}
