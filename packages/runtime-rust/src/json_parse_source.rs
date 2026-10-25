/// Source tokens parallel the parsed data without duplicating the value tree.
/// Object entries retain lexical duplicates; the last entry owns their source.
pub enum JsonSourceTree {
    Primitive(JsString),
    Array(Vec<JsonSourceTree>),
    Object(Vec<(JsString, JsonSourceTree)>),
}

struct JsonSourceLocations {
    units: Vec<u16>,
    boundaries: Vec<(usize, usize)>,
}

impl JsonSourceLocations {
    fn new(text: &JsString) -> Self {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut boundaries = vec![(0, 0)];
        let (mut bytes, mut offset) = (0, 0);
        let (mut quoted, mut escaped) = (false, false);
        // Match json_source_utf8's treatment of raw lone surrogates. Token
        // boundaries map back to the original UTF-16, including escaped units.
        for item in char::decode_utf16(units.iter().copied()) {
            match item {
                Ok(ch) => {
                    bytes += ch.len_utf8();
                    offset += ch.len_utf16();
                    if escaped {
                        escaped = false;
                    } else if quoted && ch == '\\' {
                        escaped = true;
                    } else if ch == '"' {
                        quoted = !quoted;
                    }
                }
                Err(_) => {
                    bytes += if quoted && !escaped { 6 } else { 3 };
                    offset += 1;
                    escaped = false;
                }
            }
            boundaries.push((bytes, offset));
        }
        Self { units, boundaries }
    }

    fn extract(&self, start: usize, end: usize) -> JsString {
        let unit = |byte| {
            self.boundaries[self
                .boundaries
                .binary_search_by_key(&byte, |&(byte, _)| byte)
                .expect("JSON token boundary")]
            .1
        };
        JsString::from_utf16(&self.units[unit(start)..unit(end)])
    }
}

/// Parse data and retain exact primitive tokens for JSON.parse revivers.
pub fn json_parse_with_source(text: &JsString) -> Result<(JsonNode, JsonSourceTree), String> {
    let normalized = json_source_utf8(text);
    let mut parser = JsonParser::new(&normalized);
    parser.source_locations = Some(JsonSourceLocations::new(text));
    let node = parser.parse_value()?;
    Ok((node, parser.last_source.expect("JSON root source")))
}
