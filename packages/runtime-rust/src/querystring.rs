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
