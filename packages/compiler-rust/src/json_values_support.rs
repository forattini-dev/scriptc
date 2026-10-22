// Adapter over the compiler's owning data representation. Traversal, callback
// ordering, indentation and cycle tracking live in the shared Rust runtime.
impl runtime::NativeJsonValue for NativeValue {
    fn json_kind(&self) -> runtime::NativeJsonKind { native_json_kind(self) }
    fn json_undefined() -> Self { Self::Undefined }
    fn json_from_node(node: runtime::JsonNode) -> Self {
        match node {
            runtime::JsonNode::Null => Self::Null,
            runtime::JsonNode::Bool(v) => Self::Boolean(v),
            runtime::JsonNode::Number(v) => Self::Number(v),
            runtime::JsonNode::String(v) => Self::String(native_json_text(v)),
            runtime::JsonNode::Array(values) => Self::Array(runtime::array_new(values.into_iter().map(Self::json_from_node).collect())),
            runtime::JsonNode::Object(values) => {
                let mut entries = Vec::new();
                for (key,value) in values { js_data_set(&mut entries, native_json_text(key), Self::json_from_node(value)); }
                Self::Object(runtime::Gc::new(NativeMap { entries }))
            }
        }
    }
    fn json_root(value: Self) -> Self { Self::Object(runtime::Gc::new(NativeMap { entries: vec![(String::new(), value)] })) }
    fn json_get(&self, key: &runtime::JsString) -> Self { native_value_get(self.clone(), native_json_text(key.clone())) }
    fn json_keys(&self) -> Vec<runtime::JsString> {
        let keys = match self { Self::Record(..) | Self::Object(..) => native_value_own_keys(self), _ => native_json_typed_keys(self) };
        let mut keys = keys;
        keys.sort_by_key(|key| key.parse::<u32>().ok().filter(|i| *i != u32::MAX && i.to_string() == *key).map(|i| (0,i)).unwrap_or((1,0)));
        keys.into_iter().map(runtime::JsString::from).collect()
    }
    fn json_call(&self, _holder: &Self, args: &[Self]) -> Self { native_value_call(self.clone(), args.to_vec(), "JSON callback") }
    fn json_primitive_string(&self) -> runtime::JsString { runtime::string(&native_value_string(self.clone())) }
}
fn native_json_text(value: runtime::JsString) -> String {
    String::from_utf16(&runtime::JsStringSource::utf16_units(&value).collect::<Vec<_>>()).unwrap_or_else(|_| runtime::throw_type_error("scriptc: lone UTF-16 JSON strings are not ported".into()))
}
