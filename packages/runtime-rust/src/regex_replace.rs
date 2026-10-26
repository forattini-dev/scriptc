/// A snapshot of one builtin RegExp match, before any replacement callbacks run.
pub struct RegexReplacementMatch {
    pub matched: JsString,
    pub captures: Vec<Option<JsString>>,
    pub offset: usize,
    pub input: JsString,
    pub groups: Option<Vec<(JsString, Option<JsString>)>>,
}

/// Match collection and replacement are separate phases. In particular, global
/// matching finishes (and resets lastIndex) before user code can observe it.
pub fn regex_replace_captures(
    subject: &JsString,
    regex: &JsRegex,
    require_global: bool,
    mut replacement: impl FnMut(RegexReplacementMatch) -> JsString,
) -> JsString {
    if require_global && !regex.global {
        throw_type_error(
            "String.prototype.replaceAll called with a non-global RegExp argument".to_owned(),
        );
    }
    let units: Vec<u16> = subject.encode_utf16().collect();
    let mut position = if regex.sticky && !regex.global {
        regex_start_index(regex)
    } else {
        0
    };
    if regex.global {
        regex.last_index.set(0.0);
    }
    let mut matches = Vec::new();
    loop {
        let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
            if regex.global || regex.sticky {
                regex.last_index.set(0.0);
            }
            break;
        };
        let range = matched.range();
        if regex.global || regex.sticky {
            regex.last_index.set(range.end as f64);
        }
        position = if range.is_empty() {
            advance_string_index(&units, range.end, regex.unicode)
        } else {
            range.end
        };
        matches.push(matched);
        if !regex.global {
            break;
        }
    }
    let mut output = Vec::new();
    let mut next = 0;
    for matched in matches {
        let range = matched.range();
        let captures = matched
            .captures
            .iter()
            .map(|capture| {
                capture
                    .as_ref()
                    .map(|range| string_from_utf16(&units[range.clone()]))
            })
            .collect();
        let mut groups = Vec::new();
        for (name, capture) in matched.named_groups() {
            let text = capture.map(|range| string_from_utf16(&units[range]));
            // Duplicate names in disjoint alternatives share one property.
            if let Some((_, value)) = groups.iter_mut().find(|(key, _)| key == name) {
                if text.is_some() {
                    *value = text;
                }
            } else {
                groups.push((string(name), text));
            }
        }
        let value = replacement(RegexReplacementMatch {
            matched: string_from_utf16(&units[range.clone()]),
            captures,
            offset: range.start,
            input: subject.clone(),
            groups: (!groups.is_empty()).then_some(groups),
        });
        output.extend_from_slice(&units[next..range.start]);
        output.extend(value.encode_utf16());
        next = range.end;
    }
    output.extend_from_slice(&units[next..]);
    string_from_utf16(&output)
}
