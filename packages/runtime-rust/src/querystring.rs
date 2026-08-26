pub fn querystring_escape(value: &JsString) -> JsString {
    string_encode_uri_component(value)
}

pub fn querystring_unescape(value: &JsString) -> JsString {
    if let Some(decoded) = string_decode_uri_component_try(value) {
        return decoded;
    }

    // Node's legacy fallback scans UTF-16 code units and writes each result
    // into a Buffer byte. Non-escaped units therefore intentionally lose
    // their high byte, including both halves of an astral surrogate pair.
    let units = value.encode_utf16().collect::<Vec<_>>();
    let mut bytes = Vec::with_capacity(units.len());
    let mut index = 0usize;
    while index < units.len() {
        let current = units[index];
        if current == u16::from(b'%') && index + 2 < units.len() {
            let high = u8::try_from(units[index + 1]).ok().and_then(uri_hex_nibble);
            let low = u8::try_from(units[index + 2]).ok().and_then(uri_hex_nibble);
            if let (Some(high), Some(low)) = (high, low) {
                bytes.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        bytes.push(current as u8);
        index += 1;
    }

    Rc::from(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Clone)]
pub enum QuerystringParsedValue {
    String(JsString),
    Strings(JsArray<JsString>),
}

impl HeapValue for QuerystringParsedValue {
    fn trace_value(&self, tracer: &mut Tracer<'_>) {
        if let Self::Strings(values) = self {
            tracer.edge(values);
        }
    }
}

fn querystring_piece(bytes: Vec<u8>, encoded: bool) -> JsString {
    let value: JsString =
        Rc::from(String::from_utf8(bytes).expect("querystring scan preserves UTF-8"));
    if encoded && !value.is_empty() {
        querystring_unescape(&value)
    } else {
        value
    }
}

fn querystring_add_pair(
    output: &JsMap<JsString, QuerystringParsedValue>,
    key: Vec<u8>,
    value: Vec<u8>,
    key_encoded: bool,
    value_encoded: bool,
) {
    let key = querystring_piece(key, key_encoded);
    let value = querystring_piece(value, value_encoded);
    match map_get_by(output, &key, |left, right| left.as_ref() == right.as_ref()) {
        None => map_set_by(
            output,
            key,
            QuerystringParsedValue::String(value),
            |left, right| left.as_ref() == right.as_ref(),
        ),
        Some(QuerystringParsedValue::String(previous)) => {
            let values = array_new(vec![previous, value]);
            map_set_by(
                output,
                key,
                QuerystringParsedValue::Strings(values),
                |left, right| left.as_ref() == right.as_ref(),
            );
        }
        Some(QuerystringParsedValue::Strings(values)) => {
            array_push(&values, value);
        }
    }
}

pub fn querystring_parse(
    input: &JsString,
    separator: &JsString,
    equals: &JsString,
    max_keys: f64,
) -> JsMap<JsString, QuerystringParsedValue> {
    let output = map_new();
    if input.is_empty() {
        return output;
    }
    let separator = if separator.is_empty() { "&" } else { separator };
    let equals = if equals.is_empty() { "=" } else { equals };
    let separator = separator.as_bytes();
    let equals = equals.as_bytes();
    let input = input.as_bytes();
    let mut pairs = if max_keys > 0.0 { max_keys } else { -1.0 };
    let mut key = Vec::new();
    let mut value = Vec::new();
    let mut last_position = 0usize;
    let mut separator_index = 0usize;
    let mut equals_index = 0usize;
    let mut key_encoded = false;
    let mut value_encoded = false;
    let mut encode_check = 0u8;

    for (index, code) in input.iter().copied().enumerate() {
        if code == separator[separator_index] {
            separator_index += 1;
            if separator_index == separator.len() {
                let end = index + 1 - separator_index;
                if equals_index < equals.len() {
                    if last_position < end {
                        key.extend_from_slice(&input[last_position..end]);
                    } else if key.is_empty() {
                        pairs -= 1.0;
                        if pairs == 0.0 {
                            return output;
                        }
                        last_position = index + 1;
                        separator_index = 0;
                        equals_index = 0;
                        continue;
                    }
                } else if last_position < end {
                    value.extend_from_slice(&input[last_position..end]);
                }
                querystring_add_pair(&output, key, value, key_encoded, value_encoded);
                pairs -= 1.0;
                if pairs == 0.0 {
                    return output;
                }
                key = Vec::new();
                value = Vec::new();
                key_encoded = false;
                value_encoded = false;
                encode_check = 0;
                last_position = index + 1;
                separator_index = 0;
                equals_index = 0;
            }
            continue;
        }

        separator_index = 0;
        if equals_index < equals.len() {
            if code == equals[equals_index] {
                equals_index += 1;
                if equals_index == equals.len() {
                    let end = index + 1 - equals_index;
                    if last_position < end {
                        key.extend_from_slice(&input[last_position..end]);
                    }
                    encode_check = 0;
                    last_position = index + 1;
                }
                continue;
            }
            equals_index = 0;
            if !key_encoded {
                if code == b'%' {
                    encode_check = 1;
                    continue;
                } else if encode_check > 0 {
                    if uri_hex_nibble(code).is_some() {
                        encode_check += 1;
                        if encode_check == 3 {
                            key_encoded = true;
                        }
                        continue;
                    }
                    encode_check = 0;
                }
            }
            if code == b'+' {
                if last_position < index {
                    key.extend_from_slice(&input[last_position..index]);
                }
                key.push(b' ');
                last_position = index + 1;
                continue;
            }
        }
        if code == b'+' {
            if last_position < index {
                value.extend_from_slice(&input[last_position..index]);
            }
            value.push(b' ');
            last_position = index + 1;
        } else if !value_encoded {
            if code == b'%' {
                encode_check = 1;
            } else if encode_check > 0 {
                if uri_hex_nibble(code).is_some() {
                    encode_check += 1;
                    if encode_check == 3 {
                        value_encoded = true;
                    }
                } else {
                    encode_check = 0;
                }
            }
        }
    }

    let mut ended_empty = false;
    if last_position < input.len() {
        if equals_index < equals.len() {
            key.extend_from_slice(&input[last_position..]);
        } else if separator_index < separator.len() {
            value.extend_from_slice(&input[last_position..]);
        }
    } else if equals_index == 0 && key.is_empty() {
        ended_empty = true;
    }
    if !ended_empty {
        querystring_add_pair(&output, key, value, key_encoded, value_encoded);
    }
    output
}

pub trait QuerystringDyn: HeapValue + ArrayElement {
    fn querystring_object_entries(&self) -> Option<Vec<(JsString, Self)>>;
    fn querystring_array_values(&self) -> Option<Vec<Self>>;
    fn querystring_scalar(&self) -> JsString;
}

pub fn querystring_stringify<T: QuerystringDyn>(
    object: &T,
    separator: &JsString,
    equals: &JsString,
) -> JsString {
    let separator = if separator.is_empty() { "&" } else { separator };
    let equals = if equals.is_empty() { "=" } else { equals };
    let Some(entries) = object.querystring_object_entries() else {
        return empty_string();
    };
    let mut output = String::new();
    for (key, value) in entries {
        let key = querystring_escape(&key);
        let values = value.querystring_array_values();
        let values = values.as_deref().unwrap_or(std::slice::from_ref(&value));
        for value in values {
            if !output.is_empty() {
                output.push_str(separator);
            }
            output.push_str(&key);
            output.push_str(equals);
            output.push_str(&querystring_escape(&value.querystring_scalar()));
        }
    }
    Rc::from(output)
}
