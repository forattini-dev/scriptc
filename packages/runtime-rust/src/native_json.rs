/// A protocol over compiled owning values, shared by native emitters. It reads
/// data and invokes compiled callbacks; it never evaluates JavaScript source.
pub enum NativeJsonKind {
    Undefined,
    Null,
    Boolean(bool),
    Number(f64),
    String(JsString),
    Symbol,
    BigInt,
    Function,
    Array { identity: usize, length: usize },
    Object { identity: usize },
    Unsupported,
}
pub trait NativeJsonValue: Clone {
    fn json_kind(&self) -> NativeJsonKind;
    fn json_undefined() -> Self;
    fn json_from_node(node: JsonNode) -> Self;
    fn json_root(value: Self) -> Self;
    fn json_get(&self, key: &JsString) -> Self;
    fn json_keys(&self) -> Vec<JsString>;
    fn json_call(&self, holder: &Self, args: &[Self]) -> Self;
    fn json_primitive_string(&self) -> JsString;
    fn json_raw_json(&self) -> Option<JsRawJson> { None }
    fn json_from_raw_json(_value: JsRawJson) -> Self {
        throw_type_error("scriptc: raw JSON values are not ported by this adapter".into())
    }
}

struct NativeJsonSerialization<V> {
    value: V,
    replacer: Option<V>,
    properties: Option<Rc<Vec<JsString>>>,
}
fn native_json_prepare<V: NativeJsonValue>(
    holder: &V,
    key: &JsString,
    replacer: &Option<V>,
    properties: &Option<Rc<Vec<JsString>>>,
) -> NativeJsonSerialization<V> {
    let mut value = holder.json_get(key);
    if matches!(value.json_kind(), NativeJsonKind::Unsupported) {
        throw_type_error("scriptc: JSON value object protocol is not ported".into());
    }
    if matches!(
        value.json_kind(),
        NativeJsonKind::Object { .. }
            | NativeJsonKind::Array { .. }
            | NativeJsonKind::Function
            | NativeJsonKind::BigInt
    ) {
        let hook = value.json_get(&string("toJSON"));
        if matches!(hook.json_kind(), NativeJsonKind::Function) {
            value = hook.json_call(&value, &[V::json_from_node(JsonNode::String(key.clone()))]);
        }
    }
    if let Some(callback) = replacer {
        value = callback.json_call(
            holder,
            &[V::json_from_node(JsonNode::String(key.clone())), value],
        );
    }
    NativeJsonSerialization {
        value,
        replacer: replacer.clone(),
        properties: properties.clone(),
    }
}
impl<V: NativeJsonValue> JsonValue for NativeJsonSerialization<V> {
    fn is_json_undefined(&self) -> bool {
        matches!(
            self.value.json_kind(),
            NativeJsonKind::Undefined | NativeJsonKind::Function | NativeJsonKind::Symbol
        )
    }
    fn write_json(&self, writer: &mut JsonWriter) {
        use NativeJsonKind as K;
        if let Some(raw) = self.value.json_raw_json() {
            raw.write_json(writer);
            return;
        }
        match self.value.json_kind() {
            K::Undefined | K::Null | K::Function | K::Symbol => writer.write_null(),
            K::Boolean(value) => value.write_json(writer),
            K::Number(value) => value.write_json(writer),
            K::String(value) => value.write_json(writer),
            K::BigInt => throw_type_error("Do not know how to serialize a BigInt".into()),
            K::Object { identity } => {
                let keys = self
                    .properties
                    .as_ref()
                    .map_or_else(|| self.value.json_keys(), |keys| keys.as_ref().clone());
                json_write_native_object(identity, keys, writer, |key| {
                    native_json_prepare(&self.value, key, &self.replacer, &self.properties)
                });
            }
            K::Array { identity, length } => {
                json_write_native_array(identity, length, writer, |index| {
                    native_json_prepare(
                        &self.value,
                        &string(&index.to_string()),
                        &self.replacer,
                        &self.properties,
                    )
                })
            }
            K::Unsupported => throw_type_error(
                "scriptc: JSON serialization of this native value is not ported".into(),
            ),
        }
    }
}

pub fn json_write_native_object<T: JsonValue>(
    identity: usize,
    keys: Vec<JsString>,
    writer: &mut JsonWriter,
    read: impl Fn(&JsString) -> T,
) {
    if let Some(start) = writer
        .stack
        .iter()
        .position(|entry| entry.identity == identity)
    {
        throw_type_error(writer.circular_message(start));
    }
    writer.stack.push(JsonSeen {
        identity,
        is_array: false,
        edge: None,
    });
    writer.begin_object();
    let mut first = true;
    for key in keys {
        writer.property(&mut first, &key, &read(&key));
    }
    writer.end_object();
    writer.stack.pop().expect("native JSON object stack");
}
pub fn json_write_native_array<T: JsonValue>(
    identity: usize,
    length: usize,
    writer: &mut JsonWriter,
    read: impl Fn(usize) -> T,
) {
    if let Some(start) = writer
        .stack
        .iter()
        .position(|entry| entry.identity == identity)
    {
        throw_type_error(writer.circular_message(start));
    }
    writer.stack.push(JsonSeen {
        identity,
        is_array: true,
        edge: None,
    });
    writer.begin_array();
    let mut first = true;
    for index in 0..length {
        writer.element(&mut first, index, &read(index));
    }
    writer.end_array();
    writer.stack.pop().expect("native JSON array stack");
}

pub fn native_json_stringify<V: NativeJsonValue>(args: Vec<V>) -> V {
    use NativeJsonKind as K;
    let value = args.first().cloned().unwrap_or_else(V::json_undefined);
    let replacer = args.get(1).cloned().unwrap_or_else(V::json_undefined);
    let (callback, properties) = match replacer.json_kind() {
        K::Function => (Some(replacer), None),
        K::Array { length, .. } => {
            let mut keys = Vec::new();
            for index in 0..length {
                let item = replacer.json_get(&string(&index.to_string()));
                let key = match item.json_kind() {
                    K::String(value) => Some(value),
                    K::Number(_) => Some(item.json_primitive_string()),
                    K::Unsupported => {
                        throw_type_error("scriptc: boxed JSON replacer keys are not ported".into())
                    }
                    _ => None,
                };
                if let Some(key) = key
                    && !keys.contains(&key)
                {
                    keys.push(key);
                }
            }
            (None, Some(Rc::new(keys)))
        }
        K::Unsupported => throw_type_error(
            "scriptc: native object JSON replacer classification is not ported".into(),
        ),
        _ => (None, None),
    };
    let space = args.get(2).cloned().unwrap_or_else(V::json_undefined);
    let indent = match space.json_kind() {
        K::Number(value) => JsString::from(" ".repeat(if value.is_nan() || value < 0.0 {
            0
        } else {
            value.min(10.0) as usize
        })),
        K::String(value) => {
            let units = value.utf16_units().take(10).collect::<Vec<_>>();
            JsString::from_utf16(&units)
        }
        K::Unsupported => throw_type_error("scriptc: boxed JSON indentation is not ported".into()),
        _ => JsString::default(),
    };
    let root = V::json_root(value);
    let result = native_json_prepare(&root, &empty_string(), &callback, &properties);
    if result.is_json_undefined() {
        V::json_undefined()
    } else {
        V::json_from_node(JsonNode::String(json_stringify_indented(&result, &indent)))
    }
}

pub fn native_json_parse<V: NativeJsonValue>(args: Vec<V>) -> V {
    if args
        .get(1)
        .is_some_and(|value| matches!(value.json_kind(), NativeJsonKind::Function))
    {
        throw_type_error("scriptc: JSON.parse reviver and source context are not ported".into());
    }
    let text = args
        .first()
        .cloned()
        .unwrap_or_else(V::json_undefined)
        .json_primitive_string();
    match json_parse_node(&text) {
        Ok(node) => V::json_from_node(node),
        Err(message) => throw_syntax_error(message),
    }
}
