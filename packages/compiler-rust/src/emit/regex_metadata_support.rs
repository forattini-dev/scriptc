fn native_regex_metadata<T: runtime::ArrayElement>(row: &runtime::JsArray<T>, key: &runtime::JsString) -> Option<NativeValue> {
    if (key == "groups" || key == "indices") && runtime::array_regex_metadata(row).is_some() {
        runtime::throw_type_error("scriptc: native RegExp result group objects and indices are not supported yet".into());
    }
    if key == "index" {
        return Some(runtime::array_regex_metadata(row).map(|(index, _)| NativeValue::Number(index)).unwrap_or(NativeValue::Undefined));
    }
    if key == "input" {
        return Some(runtime::array_regex_metadata(row).map(|(_, input)| NativeValue::String(input)).unwrap_or(NativeValue::Undefined));
    }
    None
}
