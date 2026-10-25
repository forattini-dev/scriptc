// Adapter over the compiler's owning data representation. Traversal, callback
// ordering, indentation and cycle tracking live in the shared Rust runtime.
impl runtime::NativeJsonValue for NativeValue {
    fn json_kind(&self) -> runtime::NativeJsonKind { native_json_kind(self) }
    fn json_raw_json(&self) -> Option<runtime::JsRawJson> { if let Self::RawJson(value) = self { Some(value.clone()) } else { None } }
    fn json_from_raw_json(value: runtime::JsRawJson) -> Self { Self::RawJson(value) }
    fn json_undefined() -> Self { Self::Undefined }
    fn json_from_node(node: runtime::JsonNode) -> Self {
        match node {
            runtime::JsonNode::Null => Self::Null,
            runtime::JsonNode::Bool(v) => Self::Boolean(v),
            runtime::JsonNode::Number(v) => Self::Number(v),
            runtime::JsonNode::String(v) => Self::String(v),
            runtime::JsonNode::Array(values) => Self::Array(runtime::array_new(values.into_iter().map(Self::json_from_node).collect())),
            runtime::JsonNode::Object(values) => {
                let mut entries = Vec::new();
                for (key,value) in values { js_data_set(&mut entries, key, Self::json_from_node(value)); }
                Self::Object(runtime::Gc::new(NativeMap { entries }))
            }
        }
    }
    fn json_root(value: Self) -> Self { Self::Object(runtime::Gc::new(NativeMap { entries: vec![(runtime::JsString::default(), value)] })) }
    fn json_get(&self, key: &runtime::JsString) -> Self { native_value_get(self.clone(), key.clone()) }
    fn json_define(&self, key: &runtime::JsString, value: Self) {
        match self {
            Self::Object(object) | Self::Record(_, object) => object.with_mut(|data| js_data_set(&mut data.entries, key.clone(), value)),
            Self::Array(array) => runtime::array_set(array, key.parse::<f64>().expect("JSON array index"), value),
            _ => runtime::throw_type_error("scriptc: JSON reviver property creation requires a native data object".into()),
        }
    }
    fn json_delete(&self, key: &runtime::JsString) {
        match self {
            Self::Object(object) | Self::Record(_, object) => object.with_mut(|data| data.entries.retain(|(name, _)| name != key)),
            Self::Array(array) => { runtime::array_delete(array, key.parse::<f64>().expect("JSON array index")); },
            _ => runtime::throw_type_error("scriptc: JSON reviver property deletion requires a native data object".into()),
        }
    }
    fn json_keys(&self) -> Vec<runtime::JsString> {
        let keys = match self { Self::Record(..) | Self::Object(..) => native_value_own_keys(self), _ => native_json_typed_keys(self) };
        let mut keys = keys;
        keys.sort_by_key(|key| key.parse::<u32>().ok().filter(|i| *i != u32::MAX && *key == i.to_string()).map(|i| (0,i)).unwrap_or((1,0)));
        keys.into_iter().map(runtime::JsString::from).collect()
    }
    fn json_call(&self, holder: &Self, args: &[Self]) -> Self { native_value_call_with_this(self.clone(), holder.clone(), args.to_vec(), "JSON callback") }
    fn json_primitive_string(&self) -> runtime::JsString { runtime::string(&native_value_string(self.clone())) }
}
