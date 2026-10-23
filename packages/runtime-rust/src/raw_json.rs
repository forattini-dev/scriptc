/// Immutable, identity-bearing raw JSON. Only validated primitive JSON text can
/// create this brand; an ordinary object with a rawJSON field cannot forge it.
#[derive(Clone)]
pub struct JsRawJson(Rc<JsString>);

impl JsRawJson {
    pub fn text(&self) -> JsString {
        self.0.as_ref().clone()
    }

    pub fn identity(&self) -> usize {
        Rc::as_ptr(&self.0) as usize
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }

    pub fn refuse_write(&self, key: &JsString) -> ! {
        if key == "rawJSON" {
            throw_type_error(
                "Cannot assign to read only property 'rawJSON' of object '[object Object]'".into(),
            );
        }
        throw_type_error(format!(
            "Cannot add property {key}, object is not extensible"
        ));
    }
}

impl JsonValue for JsRawJson {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.output.push_str(self.0.as_ref());
    }
}

pub fn raw_json_from_text(text: &JsString) -> Result<JsRawJson, String> {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let end = |unit: u16| matches!(unit, 0x61..=0x7a | 0x30..=0x39 | 0x22);
    if units.is_empty() || !(end(units[0]) || units[0] == 0x2d) || !end(units[units.len() - 1]) {
        return Err("Invalid value for JSON.rawJSON".into());
    }
    match json_parse_node(text)? {
        JsonNode::Null | JsonNode::Bool(_) | JsonNode::Number(_) | JsonNode::String(_) => {
            Ok(JsRawJson(Rc::new(text.clone())))
        }
        JsonNode::Array(_) | JsonNode::Object(_) => Err("Invalid value for JSON.rawJSON".into()),
    }
}

pub fn native_json_raw_json<V: NativeJsonValue>(args: Vec<V>) -> V {
    let text = args
        .first()
        .cloned()
        .unwrap_or_else(V::json_undefined)
        .json_primitive_string();
    let raw = raw_json_from_text(&text).unwrap_or_else(|message| throw_syntax_error(message));
    V::json_from_raw_json(raw)
}

pub fn native_json_is_raw_json<V: NativeJsonValue>(args: Vec<V>) -> V {
    let raw = args
        .first()
        .is_some_and(|value| value.json_raw_json().is_some());
    V::json_from_node(JsonNode::Bool(raw))
}

#[cfg(test)]
mod raw_json_tests {
    use super::*;

    #[test]
    fn raw_json_preserves_spelling_and_allocation_identity() {
        for text in [
            "9007199254740993123456789",
            "1e400",
            "-0",
            "1.2300",
            "true",
            "false",
            "null",
            "\"\\u0061\"",
        ] {
            let raw = raw_json_from_text(&string(text)).unwrap();
            assert_eq!(json_stringify(&raw), text);
            assert!(raw.ptr_eq(&raw.clone()));
            assert!(!raw.ptr_eq(&raw_json_from_text(&string(text)).unwrap()));
        }
        for text in [
            "",
            " 1",
            "1 ",
            "{}",
            "[]",
            "01",
            "NaN",
            "undefined",
            "true false",
            "\"bad\nstring\"",
        ] {
            assert!(raw_json_from_text(&string(text)).is_err(), "{text:?}");
        }
    }

    #[test]
    fn raw_json_and_indentation_preserve_isolated_utf16_units() {
        let text = JsString::from_utf16(&[0x22, 0xd800, 0x22]);
        let raw = raw_json_from_text(&text).unwrap();
        assert_eq!(raw.text(), text);
        assert_eq!(json_stringify(&raw), text);
        let value = JsonNode::Object(vec![(string("key"), JsonNode::Number(1.0))]);
        let indent = JsString::from_utf16(&[0xd800]);
        let actual = json_stringify_indented(&value, &indent);
        let mut expected = JsStringBuilder::new();
        expected.push_str("{\n");
        expected.push_str(&indent);
        expected.push_str("\"key\": 1\n}");
        assert_eq!(actual, expected.finish());
    }
}
