// The IR operation only admits standard owning sequences. Arbitrary iterators
// need a native iterator/close contract before they can cross this boundary.
fn native_value_iter_n(value: NativeValue, count: usize) -> NativeValue {
    let output = runtime::array_new(Vec::new());
    if let NativeValue::String(text) = &value {
        let points = runtime::string_iteration_prefix(text, count);
        for index in 0..count {
            runtime::array_push(&output, points.get(index).cloned().map(NativeValue::String).unwrap_or(NativeValue::Undefined));
        }
    } else if let Some(length) = native_iteration_length(&value) {
        for index in 0..count {
            let item = if index < length { native_iteration_item(&value, index) } else { NativeValue::Undefined };
            runtime::array_push(&output, item);
        }
    } else {
        if native_value_test(&value, "map") || native_value_test(&value, "set") {
            runtime::throw_type_error("scriptc: array binding Map/Set iterators are not ported".into());
        }
        let description = match &value {
            NativeValue::Undefined => "undefined".into(),
            NativeValue::Null => "object null".into(),
            NativeValue::Boolean(value) => format!("boolean {value}"),
            NativeValue::Number(value) => format!("number {}", runtime::display_number(*value)),
            NativeValue::BigInt(_) => "bigint".into(),
            NativeValue::Symbol(_) => "symbol".into(),
            _ if native_value_test(&value, "function") => "function".into(),
            _ => "object".into(),
        };
        runtime::throw_type_error(format!("{description} is not iterable (cannot read property Symbol(Symbol.iterator))"));
    }
    NativeValue::Array(output)
}
