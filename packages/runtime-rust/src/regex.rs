pub struct RegexData {
    compiled: regress::Regex,
    source: JsString,
    flags: JsString,
    unicode: bool,
    global: bool,
    sticky: bool,
    last_index: Cell<usize>,
}

pub type JsRegex = Rc<RegexData>;

pub fn regex_new(pattern: &str, flags: &str) -> JsRegex {
    let parsed_flags = regress::Flags::from(flags);
    let unicode = flags.contains('u') || flags.contains('v');
    let compiled = if unicode {
        regress::Regex::from_unicode(pattern.chars().map(u32::from), parsed_flags)
    } else {
        regress::Regex::from_unicode(pattern.encode_utf16().map(u32::from), parsed_flags)
    }
    .unwrap_or_else(|error| throw_syntax_error(error.to_string()));
    Rc::new(RegexData {
        compiled,
        source: string(pattern),
        flags: string(flags),
        unicode,
        global: flags.contains('g'),
        sticky: flags.contains('y'),
        last_index: Cell::new(0),
    })
}

fn regex_find(
    regex: &JsRegex,
    units: &[u16],
    start: usize,
    sticky: bool,
) -> Option<regress::Match> {
    if regex.unicode {
        regex.compiled.find_from_utf16(units, start).next()
    } else {
        regex.compiled.find_from_ucs2(units, start).next()
    }
    .filter(|matched| !sticky || matched.start() == start)
}

fn advance_string_index(units: &[u16], index: usize, unicode: bool) -> usize {
    if unicode && index + 1 < units.len() {
        let first = units[index];
        let second = units[index + 1];
        if (0xd800..=0xdbff).contains(&first) && (0xdc00..=0xdfff).contains(&second) {
            return index + 2;
        }
    }
    index.saturating_add(1)
}

fn string_from_utf16(units: &[u16]) -> JsString {
    Rc::from(String::from_utf16_lossy(units))
}

pub fn string_from_char_codes(codes: &JsArray<f64>) -> JsString {
    let units = (0..array_len(codes) as usize)
        .map(|index| to_uint32(array_get(codes, index as f64)) as u16)
        .collect::<Vec<_>>();
    string_from_utf16(&units)
}

pub fn string_from_char_code_bytes<T: ByteElement>(codes: &JsBytes<T>) -> JsString {
    let units = (0..bytes_len(codes) as usize)
        .map(|index| to_uint32(bytes_get(codes, index as f64)) as u16)
        .collect::<Vec<_>>();
    string_from_utf16(&units)
}

pub fn regex_test(regex: &JsRegex, text: &JsString) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    let stateful = regex.global || regex.sticky;
    let start = if stateful { regex.last_index.get() } else { 0 };
    let found = regex_find(regex, &units, start, regex.sticky);
    if stateful {
        regex
            .last_index
            .set(found.as_ref().map_or(0, regress::Match::end));
    }
    found.is_some()
}

fn regex_match_row(units: &[u16], matched: &regress::Match) -> JsArray<JsString> {
    let mut values = Vec::with_capacity(matched.captures.len() + 1);
    values.push(string_from_utf16(&units[matched.range()]));
    for group in &matched.captures {
        values.push(group.as_ref().map_or_else(empty_string, |range| {
            string_from_utf16(&units[range.clone()])
        }));
    }
    array_new(values)
}

pub fn regex_match(subject: &JsString, regex: &JsRegex) -> Option<JsArray<JsString>> {
    let units: Vec<u16> = subject.encode_utf16().collect();
    if regex.global {
        regex.last_index.set(0);
        let mut values = Vec::new();
        let mut position = 0usize;
        while position <= units.len() {
            let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
                break;
            };
            let start = matched.start();
            let end = matched.end();
            values.push(string_from_utf16(&units[matched.range()]));
            position = if start == end {
                advance_string_index(&units, end, regex.unicode)
            } else {
                end
            };
        }
        regex.last_index.set(0);
        return (!values.is_empty()).then(|| array_new(values));
    }
    let start = if regex.sticky {
        regex.last_index.get()
    } else {
        0
    };
    let matched = regex_find(regex, &units, start, regex.sticky);
    if regex.sticky {
        regex
            .last_index
            .set(matched.as_ref().map_or(0, regress::Match::end));
    }
    matched.map(|matched| regex_match_row(&units, &matched))
}

pub fn regex_search(subject: &JsString, regex: &JsRegex) -> f64 {
    let units: Vec<u16> = subject.encode_utf16().collect();
    regex_find(regex, &units, 0, regex.sticky).map_or(-1.0, |matched| matched.start() as f64)
}

fn regex_match_all_impl(
    subject: &JsString,
    regex: &JsRegex,
    indices: Option<&JsArray<f64>>,
) -> JsArray<JsArray<JsString>> {
    if !regex.global {
        throw_type_error(
            "String.prototype.matchAll called with a non-global RegExp argument".to_owned(),
        );
    }
    let units: Vec<u16> = subject.encode_utf16().collect();
    let mut rows = Vec::new();
    let mut position = regex.last_index.get();
    while position <= units.len() {
        let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
            break;
        };
        let start = matched.start();
        let end = matched.end();
        if let Some(indices) = indices {
            array_push(indices, start as f64);
        }
        rows.push(regex_match_row(&units, &matched));
        position = if start == end {
            advance_string_index(&units, end, regex.unicode)
        } else {
            end
        };
    }
    array_new(rows)
}

pub fn regex_match_all(subject: &JsString, regex: &JsRegex) -> JsArray<JsArray<JsString>> {
    regex_match_all_impl(subject, regex, None)
}

pub fn regex_match_all_into(
    subject: &JsString,
    regex: &JsRegex,
    indices: &JsArray<f64>,
) -> JsArray<JsArray<JsString>> {
    regex_match_all_impl(subject, regex, Some(indices))
}

fn regex_put_substitution(
    output: &mut Vec<u16>,
    subject: &[u16],
    matched: &regress::Match,
    replacement: &[u16],
) {
    let whole = matched.range();
    let has_named_groups = matched.named_groups().next().is_some();
    let mut index = 0usize;
    while index < replacement.len() {
        if replacement[index] != b'$' as u16 || index + 1 >= replacement.len() {
            output.push(replacement[index]);
            index += 1;
            continue;
        }
        let next = replacement[index + 1];
        if next == b'$' as u16 {
            output.push(b'$' as u16);
            index += 2;
        } else if next == b'&' as u16 {
            output.extend_from_slice(&subject[whole.clone()]);
            index += 2;
        } else if next == b'`' as u16 {
            output.extend_from_slice(&subject[..whole.start]);
            index += 2;
        } else if next == b'\'' as u16 {
            output.extend_from_slice(&subject[whole.end..]);
            index += 2;
        } else if (b'0' as u16..=b'9' as u16).contains(&next) {
            let mut group = (next - b'0' as u16) as usize;
            let mut consumed = 2usize;
            if index + 2 < replacement.len() {
                let second = replacement[index + 2];
                if (b'0' as u16..=b'9' as u16).contains(&second) {
                    let two_digit = group * 10 + (second - b'0' as u16) as usize;
                    if (1..=matched.captures.len()).contains(&two_digit) {
                        group = two_digit;
                        consumed = 3;
                    }
                }
            }
            if (1..=matched.captures.len()).contains(&group) {
                if let Some(range) = matched.group(group) {
                    output.extend_from_slice(&subject[range]);
                }
                index += consumed;
            } else {
                output.push(b'$' as u16);
                index += 1;
            }
        } else if next == b'<' as u16 && has_named_groups {
            let mut close = index + 2;
            while close < replacement.len() && replacement[close] != b'>' as u16 {
                close += 1;
            }
            if close == replacement.len() {
                output.push(b'$' as u16);
                index += 1;
                continue;
            }
            let name = String::from_utf16_lossy(&replacement[index + 2..close]);
            if let Some(range) = matched
                .named_groups()
                .find_map(|(candidate, range)| (candidate == name).then_some(range).flatten())
            {
                output.extend_from_slice(&subject[range]);
            }
            index = close + 1;
        } else {
            output.push(b'$' as u16);
            index += 1;
        }
    }
}

fn regex_replace_impl(
    subject: &JsString,
    regex: &JsRegex,
    replacement: &JsString,
    require_global: bool,
) -> JsString {
    if require_global && !regex.global {
        throw_type_error(
            "String.prototype.replaceAll called with a non-global RegExp argument".to_owned(),
        );
    }
    let units: Vec<u16> = subject.encode_utf16().collect();
    let replacement_units: Vec<u16> = replacement.encode_utf16().collect();
    let mut output = Vec::new();
    let mut next = 0usize;
    let mut position = if regex.sticky && !regex.global {
        regex.last_index.get()
    } else {
        0
    };
    if regex.global {
        regex.last_index.set(0);
    }
    while position <= units.len() {
        let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
            if regex.global || regex.sticky {
                regex.last_index.set(0);
            }
            break;
        };
        let range = matched.range();
        if regex.global || regex.sticky {
            regex.last_index.set(range.end);
        }
        output.extend_from_slice(&units[next..range.start]);
        regex_put_substitution(&mut output, &units, &matched, &replacement_units);
        next = range.end;
        if !regex.global {
            break;
        }
        position = if range.start == range.end {
            advance_string_index(&units, range.end, regex.unicode)
        } else {
            range.end
        };
    }
    if regex.global {
        regex.last_index.set(0);
    }
    output.extend_from_slice(&units[next..]);
    string_from_utf16(&output)
}

pub fn regex_replace(subject: &JsString, regex: &JsRegex, replacement: &JsString) -> JsString {
    regex_replace_impl(subject, regex, replacement, false)
}

pub fn regex_replace_all(subject: &JsString, regex: &JsRegex, replacement: &JsString) -> JsString {
    regex_replace_impl(subject, regex, replacement, true)
}

pub fn regex_split(subject: &JsString, regex: &JsRegex, limit: f64) -> JsArray<JsString> {
    let limit = to_uint32(limit) as usize;
    if limit == 0 {
        return array_new(Vec::new());
    }
    let units: Vec<u16> = subject.encode_utf16().collect();
    if units.is_empty() {
        return if regex_find(regex, &units, 0, regex.sticky).is_some() {
            array_new(Vec::new())
        } else {
            array_new(vec![empty_string()])
        };
    }
    let mut pieces = Vec::new();
    let mut previous = 0usize;
    let mut position = 0usize;
    while position < units.len() {
        let Some(matched) = regex_find(regex, &units, position, regex.sticky) else {
            if !regex.sticky {
                break;
            }
            position = advance_string_index(&units, position, regex.unicode);
            continue;
        };
        if !matched.captures.is_empty() {
            throw_type_error(
                "split() with capture groups in the pattern is not supported (JS splices the captured values into the result); use a non-capturing group (?:...)".to_owned(),
            );
        }
        let range = matched.range();
        if range.end == previous {
            position = advance_string_index(&units, range.start, regex.unicode);
        } else {
            pieces.push(string_from_utf16(&units[previous..range.start]));
            if pieces.len() == limit {
                return array_new(pieces);
            }
            previous = range.end;
            position = previous;
        }
    }
    pieces.push(string_from_utf16(&units[previous..]));
    array_new(pieces)
}

pub fn regex_source(regex: &JsRegex) -> JsString {
    regex.source.clone()
}

pub fn regex_flags(regex: &JsRegex) -> JsString {
    regex.flags.clone()
}

pub fn regexp_escape(value: &JsString) -> JsString {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(value.len());
    for (index, ch) in value.chars().enumerate() {
        let code = u32::from(ch);
        let leading_alphanumeric = index == 0 && ch.is_ascii_alphanumeric();
        let syntax = matches!(
            ch,
            '^' | '$'
                | '\\'
                | '.'
                | '*'
                | '+'
                | '?'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '|'
                | '/'
        );
        let control = match ch {
            '\t' => Some('t'),
            '\n' => Some('n'),
            '\u{000b}' => Some('v'),
            '\u{000c}' => Some('f'),
            '\r' => Some('r'),
            _ => None,
        };
        let hex_escaped = matches!(
            ch,
            ',' | '-'
                | '='
                | '<'
                | '>'
                | '#'
                | '&'
                | '!'
                | '%'
                | ':'
                | ';'
                | '@'
                | '~'
                | '\''
                | '`'
                | '"'
                | ' '
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        );
        if leading_alphanumeric {
            write!(&mut output, "\\x{code:02x}").expect("writing to String cannot fail");
        } else if syntax {
            output.push('\\');
            output.push(ch);
        } else if let Some(control) = control {
            output.push('\\');
            output.push(control);
        } else if hex_escaped {
            if code < 0x100 {
                write!(&mut output, "\\x{code:02x}").expect("writing to String cannot fail");
            } else {
                write!(&mut output, "\\u{code:04x}").expect("writing to String cannot fail");
            }
        } else {
            output.push(ch);
        }
    }
    Rc::from(output)
}
