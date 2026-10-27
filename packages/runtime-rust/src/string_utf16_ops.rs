/// ECMAScript string iteration combines surrogate pairs and keeps lone units.
/// Only consume the requested prefix; array patterns need not traverse the tail.
pub fn string_iteration_prefix(value: &JsString, count: usize) -> Vec<JsString> {
    let mut units = value.encode_utf16().peekable();
    let mut output = Vec::new();
    for _ in 0..count {
        let Some(first) = units.next() else { break };
        if (0xd800..=0xdbff).contains(&first)
            && units.peek().is_some_and(|second| (0xdc00..=0xdfff).contains(second))
        {
            output.push(JsString::from_utf16(&[first, units.next().unwrap()]));
        } else {
            output.push(JsString::from_utf16(&[first]));
        }
    }
    output
}

fn string_change_case(value: &JsString, upper: bool) -> JsString {
    let mut output = JsStringBuilder::new();
    let mut run = String::new();
    let flush = |run: &mut String, output: &mut JsStringBuilder| {
        output.push_str(&if upper {
            run.to_uppercase()
        } else {
            run.to_lowercase()
        });
        run.clear();
    };
    for item in char::decode_utf16(value.encode_utf16()) {
        match item {
            Ok(ch) => run.push(ch),
            Err(error) => {
                flush(&mut run, &mut output);
                output.push_unit(error.unpaired_surrogate());
            }
        }
    }
    flush(&mut run, &mut output);
    output.finish()
}

fn string_trim_units(value: &JsString, left: bool, right: bool) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let whitespace = |unit: u16| char::from_u32(u32::from(unit)).is_some_and(javascript_whitespace);
    let mut start = 0;
    let mut end = units.len();
    if left {
        while start < end && whitespace(units[start]) {
            start += 1;
        }
    }
    if right {
        while end > start && whitespace(units[end - 1]) {
            end -= 1;
        }
    }
    string_from_utf16(&units[start..end])
}

/// JSON source may itself contain raw lone surrogates inside a string token.
/// Escape those units before the UTF-8 scanner; invalid escapes stay invalid.
fn json_source_utf8(text: &JsString) -> std::borrow::Cow<'_, str> {
    if let Some(text) = text.well_formed_utf8() {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut output = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for item in char::decode_utf16(text.encode_utf16()) {
        match item {
            Ok(ch) => {
                output.push(ch);
                if escaped {
                    escaped = false;
                } else if quoted && ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    quoted = !quoted;
                }
            }
            Err(error) => {
                if quoted && !escaped {
                    output.push_str(&format!("\\u{:04x}", error.unpaired_surrogate()));
                } else {
                    output.push('\u{fffd}');
                }
                escaped = false;
            }
        }
    }
    std::borrow::Cow::Owned(output)
}

#[cfg(test)]
mod string_iteration_tests {
    use super::*;
    #[test]
    fn bounded_string_iteration_retains_lone_units_and_surrogate_pairs() {
        let text = JsString::from_utf16(&[65, 0xd83d, 0xde00, 0xd800, 120, 0xdc00]);
        assert!(string_iteration_prefix(&text, 0).is_empty());
        let prefix = string_iteration_prefix(&text, 3);
        assert_eq!(prefix.iter().map(|v| v.encode_utf16().collect::<Vec<_>>()).collect::<Vec<_>>(), vec![vec![65], vec![0xd83d, 0xde00], vec![0xd800]]);
        assert_eq!(string_iteration_prefix(&text, 100).len(), 5);
        assert!(string_iteration_prefix(&string(""), 3).is_empty());
    }
}
