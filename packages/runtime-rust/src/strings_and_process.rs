fn array_index(index: f64, allow_end: bool, len: usize) -> usize {
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 || index > usize::MAX as f64 {
        panic!("scriptc: invalid array index");
    }
    let index = index as usize;
    if index > len || (!allow_end && index == len) {
        panic!("scriptc: array index out of bounds");
    }
    index
}

pub fn empty_string() -> JsString {
    Rc::from("")
}

pub fn string(value: &str) -> JsString {
    Rc::from(value)
}

pub fn string_concat(left: &JsString, right: &JsString) -> JsString {
    let mut result = String::with_capacity(left.len() + right.len());
    result.push_str(left);
    result.push_str(right);
    Rc::from(result)
}

pub fn string_raw(raw: &JsArray<JsString>, substitutions: &JsArray<JsString>) -> JsString {
    let raw_len = array_len(raw);
    let substitutions_len = array_len(substitutions);
    let mut output = String::new();
    let mut index = 0.0;
    while index < raw_len {
        output.push_str(&array_get(raw, index));
        if index + 1.0 < raw_len && index < substitutions_len {
            output.push_str(&array_get(substitutions, index));
        }
        index += 1.0;
    }
    Rc::from(output)
}

pub fn string_is_well_formed(_value: &JsString) -> bool {
    true
}

pub fn string_to_well_formed(value: &JsString) -> JsString {
    value.clone()
}

fn uri_unescaped(byte: u8, keep_reserved: bool) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
        || (keep_reserved
            && matches!(
                byte,
                b';' | b'/' | b'?' | b':' | b'@' | b'&' | b'=' | b'+' | b'$' | b',' | b'#'
            ))
}

fn encode_uri(value: &JsString, keep_reserved: bool) -> JsString {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";

    if value
        .as_bytes()
        .iter()
        .all(|byte| uri_unescaped(*byte, keep_reserved))
    {
        return value.clone();
    }
    let mut encoded = Vec::with_capacity(value.len().saturating_mul(3));
    for byte in value.as_bytes() {
        if uri_unescaped(*byte, keep_reserved) {
            encoded.push(*byte);
        } else {
            encoded.push(b'%');
            encoded.push(HEX[usize::from(byte >> 4)]);
            encoded.push(HEX[usize::from(byte & 0x0f)]);
        }
    }
    Rc::from(String::from_utf8(encoded).expect("URI encoding emits ASCII"))
}

pub fn string_encode_uri_component(value: &JsString) -> JsString {
    encode_uri(value, false)
}

pub fn string_encode_uri(value: &JsString) -> JsString {
    encode_uri(value, true)
}

fn uri_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn uri_hex_byte(bytes: &[u8], index: usize) -> Option<u8> {
    if bytes.get(index) != Some(&b'%') {
        return None;
    }
    let high = uri_hex_nibble(*bytes.get(index + 1)?)?;
    let low = uri_hex_nibble(*bytes.get(index + 2)?)?;
    Some((high << 4) | low)
}

pub fn string_decode_uri_component(value: &JsString) -> JsString {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }

        let Some(leading) = uri_hex_byte(bytes, index) else {
            throw_uri_error("URI malformed".to_owned());
        };
        index += 3;
        if leading < 0x80 {
            decoded.push(leading);
            continue;
        }

        let (continuations, first_low, first_high) = match leading {
            0xc2..=0xdf => (1, 0x80, 0xbf),
            0xe0 => (2, 0xa0, 0xbf),
            0xe1..=0xec | 0xee..=0xef => (2, 0x80, 0xbf),
            0xed => (2, 0x80, 0x9f),
            0xf0 => (3, 0x90, 0xbf),
            0xf1..=0xf3 => (3, 0x80, 0xbf),
            0xf4 => (3, 0x80, 0x8f),
            _ => throw_uri_error("URI malformed".to_owned()),
        };
        decoded.push(leading);
        for continuation_index in 0..continuations {
            let Some(continuation) = uri_hex_byte(bytes, index) else {
                throw_uri_error("URI malformed".to_owned());
            };
            let valid = if continuation_index == 0 {
                (first_low..=first_high).contains(&continuation)
            } else {
                (0x80..=0xbf).contains(&continuation)
            };
            if !valid {
                throw_uri_error("URI malformed".to_owned());
            }
            decoded.push(continuation);
            index += 3;
        }
    }
    Rc::from(String::from_utf8(decoded).expect("validated URI bytes are UTF-8"))
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn string_atob(value: &JsString) -> JsString {
    let mut encoded: Vec<u8> = value
        .bytes()
        .filter(|byte| !matches!(byte, b'\t' | b'\n' | 0x0c | b'\r' | b' '))
        .collect();
    if !encoded.is_empty() && encoded.len().is_multiple_of(4) {
        if encoded.last() == Some(&b'=') {
            encoded.pop();
        }
        if encoded.last() == Some(&b'=') {
            encoded.pop();
        }
    }
    if encoded.len() % 4 == 1 {
        throw_dom_exception(
            "InvalidCharacterError",
            "The string to be decoded is not correctly encoded.",
        );
    }

    let mut output = String::with_capacity(encoded.len() / 4 * 3);
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for byte in encoded {
        let Some(value) = base64_value(byte) else {
            throw_dom_exception(
                "InvalidCharacterError",
                "The string to be decoded is not correctly encoded.",
            );
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(char::from(((accumulator >> bits) & 0xff) as u8));
            accumulator &= if bits == 0 { 0 } else { (1 << bits) - 1 };
        }
    }
    Rc::from(output)
}

pub fn string_btoa(value: &JsString) -> JsString {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut bytes = Vec::with_capacity(value.len());
    for ch in value.chars() {
        let code = u32::from(ch);
        if code > 0xff {
            throw_dom_exception("InvalidCharacterError", "Invalid character");
        }
        bytes.push(code as u8);
    }

    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = u32::from(*chunk.get(1).unwrap_or(&0));
        let third = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (first << 16) | (second << 8) | third;
        output.push(char::from(ALPHABET[((triple >> 18) & 0x3f) as usize]));
        output.push(char::from(ALPHABET[((triple >> 12) & 0x3f) as usize]));
        output.push(if chunk.len() > 1 {
            char::from(ALPHABET[((triple >> 6) & 0x3f) as usize])
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            char::from(ALPHABET[(triple & 0x3f) as usize])
        } else {
            '='
        });
    }
    Rc::from(output)
}

pub fn string_base64_missing_argument() -> JsString {
    throw_type_error_code(
        "The \"input\" argument must be specified".to_owned(),
        "ERR_MISSING_ARGS",
    )
}

pub fn string_len(value: &JsString) -> f64 {
    value.encode_utf16().count() as f64
}

pub fn string_code_point_at_string(value: &JsString, index: f64) -> JsString {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return empty_string();
    }
    let target = index as usize;
    let mut position = 0usize;
    for character in value.chars() {
        let width = character.len_utf16();
        if target == position {
            return Rc::from(character.to_string());
        }
        if width == 2 && target == position + 1 {
            return string("\u{fffd}");
        }
        position += width;
    }
    empty_string()
}

pub fn string_char_at(value: &JsString, index: f64) -> JsString {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return empty_string();
    }
    let target = index as usize;
    let mut position = 0usize;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if target == position {
            return if width == 1 {
                Rc::from(ch.to_string())
            } else {
                // Like the C runtime, safe UTF-8 storage cannot represent
                // the lone surrogate JavaScript returns for an astral half.
                string("\u{fffd}")
            };
        }
        if width == 2 && target == position + 1 {
            return string("\u{fffd}");
        }
        position += width;
    }
    empty_string()
}

/// `String.prototype.at` over UTF-16 code units. The frontend intentionally
/// types this as `string` rather than `string | undefined`; preserve the
/// project's existing island-boundary divergence by throwing the same
/// catchable TypeError when the relative index is outside the string.
pub fn string_at(value: &JsString, index: f64) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let relative = if index.is_nan() { 0.0 } else { index.trunc() };
    let absolute = if relative >= 0.0 {
        relative
    } else {
        units.len() as f64 + relative
    };
    if !absolute.is_finite() || absolute < 0.0 || absolute >= units.len() as f64 {
        throw_type_error("expected string, got undefined".to_owned());
    }
    string_from_utf16(&units[absolute as usize..absolute as usize + 1])
}

pub fn string_char_code_at(value: &JsString, index: f64) -> f64 {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return f64::NAN;
    }
    value
        .encode_utf16()
        .nth(index as usize)
        .map_or(f64::NAN, f64::from)
}

fn relative_string_index(index: f64, len: usize) -> usize {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if index == f64::NEG_INFINITY {
        return 0;
    }
    if index == f64::INFINITY {
        return len;
    }
    if index < 0.0 {
        (len as f64 + index).clamp(0.0, len as f64) as usize
    } else {
        index.clamp(0.0, len as f64) as usize
    }
}

pub fn string_index_of(value: &JsString, search: &JsString, from_index: f64) -> f64 {
    let haystack: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    let start = if from_index.is_nan() {
        0
    } else if from_index == f64::INFINITY {
        haystack.len()
    } else {
        from_index.trunc().clamp(0.0, haystack.len() as f64) as usize
    };
    if needle.is_empty() {
        return start as f64;
    }
    haystack[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map_or(-1.0, |index| (start + index) as f64)
}

pub fn string_last_index_of(value: &JsString, search: &JsString) -> f64 {
    let haystack: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    if needle.is_empty() {
        return haystack.len() as f64;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
        .map_or(-1.0, |index| index as f64)
}

pub fn string_compare_utf16(left: &JsString, right: &JsString) -> i32 {
    use std::cmp::Ordering;

    match left.encode_utf16().cmp(right.encode_utf16()) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

pub fn string_substring(value: &JsString, start: f64, end: f64) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let clamp = |index: f64| {
        if index.is_nan() || index <= 0.0 {
            0
        } else if index == f64::INFINITY {
            units.len()
        } else {
            index.trunc().min(units.len() as f64) as usize
        }
    };
    let mut start = clamp(start);
    let mut end = clamp(end);
    if start > end {
        std::mem::swap(&mut start, &mut end);
    }
    string_from_utf16(&units[start..end])
}

pub fn string_slice(value: &JsString, start: f64, end: f64) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let start = relative_string_index(start, units.len());
    let end = relative_string_index(end, units.len());
    if end <= start {
        return empty_string();
    }
    Rc::from(String::from_utf16_lossy(&units[start..end]))
}

pub fn string_repeat(value: &JsString, count: f64) -> JsString {
    let count = if count.is_nan() { 0.0 } else { count.trunc() };
    if !count.is_finite() || count < 0.0 {
        panic!("RangeError: Invalid count value");
    }
    Rc::<str>::from(value.repeat(count as usize))
}

fn string_pad(value: &JsString, max_length: f64, fill: &JsString, at_start: bool) -> JsString {
    let target = if max_length.is_nan() {
        0.0
    } else {
        max_length.trunc()
    };
    let value_units: Vec<u16> = value.encode_utf16().collect();
    if target <= value_units.len() as f64 || fill.is_empty() {
        return value.clone();
    }
    if !target.is_finite() || target > usize::MAX as f64 {
        throw_range_error("Invalid string length".to_owned());
    }
    let target = target as usize;
    let fill_units: Vec<u16> = fill.encode_utf16().collect();
    let pad_length = target - value_units.len();
    let mut padded = Vec::with_capacity(target);
    let append_padding = |output: &mut Vec<u16>| {
        output.extend(fill_units.iter().copied().cycle().take(pad_length));
    };
    if at_start {
        append_padding(&mut padded);
        padded.extend_from_slice(&value_units);
    } else {
        padded.extend_from_slice(&value_units);
        append_padding(&mut padded);
    }
    Rc::from(String::from_utf16_lossy(&padded))
}

pub fn string_pad_start(value: &JsString, max_length: f64, fill: &JsString) -> JsString {
    string_pad(value, max_length, fill, true)
}

pub fn string_pad_end(value: &JsString, max_length: f64, fill: &JsString) -> JsString {
    string_pad(value, max_length, fill, false)
}

fn append_string_substitution(
    output: &mut Vec<u16>,
    source: &[u16],
    matched: &[u16],
    position: usize,
    replacement: &[u16],
) {
    let mut index = 0usize;
    while index < replacement.len() {
        if replacement[index] != u16::from(b'$') || index + 1 == replacement.len() {
            output.push(replacement[index]);
            index += 1;
            continue;
        }
        match replacement[index + 1] {
            next if next == u16::from(b'$') => output.push(u16::from(b'$')),
            next if next == u16::from(b'&') => output.extend_from_slice(matched),
            next if next == u16::from(b'`') => output.extend_from_slice(&source[..position]),
            next if next == u16::from(b'\'') => {
                output.extend_from_slice(&source[position + matched.len()..]);
            }
            _ => {
                // With no captures or named captures, $n and $<name>
                // remain literal. Consume only '$'; the next unit is
                // handled by the following iteration.
                output.push(u16::from(b'$'));
                index += 1;
                continue;
            }
        }
        index += 2;
    }
}

fn string_find_units(source: &[u16], search: &[u16], start: usize) -> Option<usize> {
    if start > source.len() {
        return None;
    }
    if search.is_empty() {
        return Some(start);
    }
    source[start..]
        .windows(search.len())
        .position(|window| window == search)
        .map(|position| start + position)
}

pub fn string_replace(value: &JsString, search: &JsString, replacement: &JsString) -> JsString {
    let source: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    let template: Vec<u16> = replacement.encode_utf16().collect();
    let Some(position) = string_find_units(&source, &needle, 0) else {
        return value.clone();
    };
    let mut output = Vec::with_capacity(source.len().saturating_add(template.len()));
    output.extend_from_slice(&source[..position]);
    append_string_substitution(&mut output, &source, &needle, position, &template);
    output.extend_from_slice(&source[position + needle.len()..]);
    string_from_utf16(&output)
}

pub fn string_replace_all(value: &JsString, search: &JsString, replacement: &JsString) -> JsString {
    let source: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    let template: Vec<u16> = replacement.encode_utf16().collect();
    let advance = needle.len().max(1);
    let mut output = Vec::with_capacity(source.len());
    let mut end_of_last_match = 0usize;
    let mut search_from = 0usize;
    let mut matched_any = false;
    while let Some(position) = string_find_units(&source, &needle, search_from) {
        matched_any = true;
        output.extend_from_slice(&source[end_of_last_match..position]);
        append_string_substitution(&mut output, &source, &needle, position, &template);
        end_of_last_match = position + needle.len();
        if position == source.len() {
            break;
        }
        search_from = position + advance;
    }
    if !matched_any {
        return value.clone();
    }
    output.extend_from_slice(&source[end_of_last_match..]);
    string_from_utf16(&output)
}

pub fn string_to_lower_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_lowercase())
}

pub fn string_to_upper_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_uppercase())
}

pub fn string_includes(value: &JsString, search: &JsString, from_index: f64) -> bool {
    string_index_of(value, search, from_index) >= 0.0
}

pub fn string_starts_with(value: &JsString, search: &JsString) -> bool {
    value.starts_with(search.as_ref())
}

pub fn string_ends_with(value: &JsString, search: &JsString) -> bool {
    value.ends_with(search.as_ref())
}

fn javascript_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn string_trim(value: &JsString) -> JsString {
    Rc::from(value.trim_matches(javascript_whitespace))
}

pub fn string_trim_start(value: &JsString) -> JsString {
    Rc::from(value.trim_start_matches(javascript_whitespace))
}

pub fn string_trim_end(value: &JsString) -> JsString {
    Rc::from(value.trim_end_matches(javascript_whitespace))
}

pub fn string_split(value: &JsString, separator: &JsString, limit: f64) -> JsArray<JsString> {
    let limit = to_uint32(limit) as usize;
    if limit == 0 {
        return array_new(Vec::new());
    }
    let parts = if separator.is_empty() {
        value
            .encode_utf16()
            .take(limit)
            .map(|unit| Rc::from(String::from_utf16_lossy(&[unit])))
            .collect()
    } else {
        value
            .split(separator.as_ref())
            .take(limit)
            .map(Rc::<str>::from)
            .collect()
    };
    array_new(parts)
}

pub fn process_argv() -> JsArray<JsString> {
    PROCESS_ARGV.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(argv) = slot.as_ref() {
            return argv.clone();
        }
        let mut native = std::env::args();
        let executable = native.next().unwrap_or_else(|| "scriptc".to_owned());
        let mut values = vec![Rc::from(executable.as_str()), Rc::from(executable.as_str())];
        values.extend(native.map(Rc::<str>::from));
        let argv = array_new(values);
        *slot = Some(argv.clone());
        argv
    })
}

pub fn process_platform() -> JsString {
    string(if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    })
}

pub fn process_cwd() -> JsString {
    Rc::from(
        std::env::current_dir()
            .expect("scriptc: current directory is unavailable")
            .to_string_lossy()
            .as_ref(),
    )
}

pub fn process_chdir(path: &JsString) {
    std::env::set_current_dir(path.as_ref())
        .unwrap_or_else(|error| throw_fs_error("chdir", path, error));
}

pub fn process_pid() -> f64 {
    f64::from(std::process::id())
}

pub fn process_exit(code: f64) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(code as i32)
}

pub fn process_is_tty(fd: f64) -> bool {
    use std::io::IsTerminal;
    match fd as i32 {
        0 => std::io::stdin().is_terminal(),
        1 => std::io::stdout().is_terminal(),
        2 => std::io::stderr().is_terminal(),
        _ => false,
    }
}

pub fn process_stdin_destroy() {}

fn process_status_id(prefix: &str, id_flag: &str) -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix(prefix)?
                    .split_whitespace()
                    .next()?
                    .parse::<f64>()
                    .ok()
            })
        })
        .or_else(|| {
            let output = std::process::Command::new("id")
                .arg(id_flag)
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<f64>()
                .ok()
        })
        .unwrap_or(0.0)
}

pub fn process_getuid() -> f64 {
    process_status_id("Uid:", "-u")
}

pub fn process_getgid() -> f64 {
    process_status_id("Gid:", "-g")
}

pub fn process_exec_path() -> JsString {
    Rc::from(
        std::env::current_exe()
            .expect("scriptc: executable path is unavailable")
            .to_string_lossy()
            .as_ref(),
    )
}

pub fn process_arch() -> JsString {
    string(if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "ia32"
    } else {
        std::env::consts::ARCH
    })
}

thread_local! {
    static PROCESS_ENV_WRITES: RefCell<Vec<(String, Option<JsString>)>> = const { RefCell::new(Vec::new()) };
}

fn process_env_name_eq(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn process_env_write(name: &JsString, value: Option<JsString>) {
    PROCESS_ENV_WRITES.with(|writes| {
        let mut writes = writes.borrow_mut();
        if let Some((_, stored)) = writes
            .iter_mut()
            .find(|(stored, _)| process_env_name_eq(stored, name))
        {
            *stored = value;
        } else {
            writes.push((name.to_string(), value));
        }
    });
}

pub fn process_env_get(name: &JsString) -> Option<JsString> {
    if let Some(value) = PROCESS_ENV_WRITES.with(|writes| {
        writes
            .borrow()
            .iter()
            .find(|(stored, _)| process_env_name_eq(stored, name))
            .map(|(_, value)| value.clone())
    }) {
        return value;
    }
    std::env::var_os(name.as_ref()).map(|value| Rc::from(value.to_string_lossy().as_ref()))
}

pub fn process_env_set(name: &JsString, value: &JsString) {
    process_env_write(name, Some(value.clone()));
}

pub fn process_env_unset(name: &JsString) {
    process_env_write(name, None);
}

pub fn process_env_pairs() -> JsArray<JsString> {
    PROCESS_ENV_WRITES.with(|writes| {
        let writes = writes.borrow();
        let mut seen = Vec::new();
        let mut pairs = Vec::new();
        for (name, value) in std::env::vars_os() {
            let name = name.to_string_lossy().into_owned();
            seen.push(name.clone());
            let value = writes
                .iter()
                .find(|(stored, _)| process_env_name_eq(stored, &name))
                .map_or_else(
                    || Some(Rc::from(value.to_string_lossy().as_ref())),
                    |(_, value)| value.clone(),
                );
            if let Some(value) = value {
                pairs.push(Rc::from(name));
                pairs.push(value);
            }
        }
        for (name, value) in writes.iter() {
            if !seen.iter().any(|seen| process_env_name_eq(seen, name)) {
                if let Some(value) = value {
                    pairs.push(Rc::from(name.as_str()));
                    pairs.push(value.clone());
                }
            }
        }
        array_new(pairs)
    })
}

pub fn process_env_apply(command: &mut std::process::Command) {
    PROCESS_ENV_WRITES.with(|writes| {
        for (name, value) in writes.borrow().iter() {
            match value {
                Some(value) => command.env(name, value.as_ref()),
                None => command.env_remove(name),
            };
        }
    });
}

pub fn process_versions_node() -> JsString {
    string("24.0.0")
}

pub fn process_versions_openssl() -> JsString {
    string("3.5.5")
}

pub fn number_parse_int(value: &JsString, radix: f64) -> f64 {
    let trimmed = value.trim_start_matches(javascript_whitespace);
    let (negative, mut digits) = if let Some(rest) = trimmed.strip_prefix('-') {
        (true, rest)
    } else if let Some(rest) = trimmed.strip_prefix('+') {
        (false, rest)
    } else {
        (false, trimmed)
    };
    let requested = to_int32(radix);
    if requested != 0 && !(2..=36).contains(&requested) {
        return f64::NAN;
    }
    let mut base = if requested == 0 { 10 } else { requested };
    if (requested == 0 || requested == 16) && (digits.starts_with("0x") || digits.starts_with("0X"))
    {
        digits = &digits[2..];
        base = 16;
    }
    let mut result = 0.0;
    let mut consumed = false;
    let mut consumed_bytes = 0;
    for byte in digits.bytes() {
        let digit = match byte {
            b'0'..=b'9' => i32::from(byte - b'0'),
            b'a'..=b'z' => i32::from(byte - b'a') + 10,
            b'A'..=b'Z' => i32::from(byte - b'A') + 10,
            _ => break,
        };
        if digit >= base {
            break;
        }
        consumed = true;
        consumed_bytes += 1;
        result = result * f64::from(base) + f64::from(digit);
    }
    if !consumed {
        return f64::NAN;
    }
    // Rust's decimal parser performs correctly-rounded conversion over the
    // full digit sequence; repeated f64 multiplication can drift by one ULP
    // for large decimal integers (unlike JavaScript's parseInt result).
    if base == 10 {
        result = digits[..consumed_bytes]
            .parse::<f64>()
            .unwrap_or(f64::INFINITY);
    }
    if negative {
        -result
    } else {
        result
    }
}

/// Rounds an exact binary/octal/hex integer to nearest-even without an
/// intermediate machine integer or cumulative floating-point arithmetic.
fn power_of_two_integer_to_f64(digits: &[u8], radix: u32) -> f64 {
    let bits_per_digit = radix.trailing_zeros() as usize;
    let first = char::from(digits[0])
        .to_digit(radix)
        .expect("validated numeric digit");
    let first_width = (u32::BITS - first.leading_zeros()) as usize;
    let bit_length = first_width + (digits.len() - 1) * bits_per_digit;
    if bit_length > 1024 {
        return f64::INFINITY;
    }

    let mut top = 0_u64;
    let mut bit_index = 0_usize;
    let mut round_bit = false;
    let mut sticky = false;
    for (digit_index, byte) in digits.iter().enumerate() {
        let digit = char::from(*byte)
            .to_digit(radix)
            .expect("validated numeric digit");
        let width = if digit_index == 0 {
            first_width
        } else {
            bits_per_digit
        };
        for shift in (0..width).rev() {
            let set = digit & (1 << shift) != 0;
            if bit_index < 53 {
                top = (top << 1) | u64::from(set);
            } else if bit_index == 53 {
                round_bit = set;
            } else {
                sticky |= set;
            }
            bit_index += 1;
        }
    }
    if bit_length <= 53 {
        return top as f64;
    }
    if round_bit && (sticky || top & 1 != 0) {
        top += 1;
    }
    (top as f64) * 2_f64.powi((bit_length - 53) as i32)
}

/// ECMA-262 StringToNumber over the complete trimmed input span.
pub fn number_from_string(value: &JsString) -> f64 {
    let trimmed = value.trim_matches(javascript_whitespace);
    if trimmed.is_empty() {
        return 0.0;
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16_u32),
            b'o' | b'O' => Some(8_u32),
            b'b' | b'B' => Some(2_u32),
            _ => None,
        };
        if let Some(radix) = radix {
            let digits = &bytes[2..];
            if digits.is_empty()
                || digits
                    .iter()
                    .any(|byte| char::from(*byte).to_digit(radix).is_none())
            {
                return f64::NAN;
            }
            let significant = digits
                .iter()
                .position(|byte| *byte != b'0')
                .map_or(&digits[digits.len()..], |start| &digits[start..]);
            return if significant.is_empty() {
                0.0
            } else {
                power_of_two_integer_to_f64(significant, radix)
            };
        }
    }

    let mut index = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let negative = bytes.first() == Some(&b'-');
    if bytes[index..] == *b"Infinity" {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let mut integer_digits = 0_usize;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
        integer_digits += 1;
    }
    let mut fraction_digits = 0_usize;
    let mut dot = None;
    if bytes.get(index) == Some(&b'.') {
        dot = Some(index);
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
            fraction_digits += 1;
        }
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent_start {
            return f64::NAN;
        }
    }
    if index != bytes.len() {
        return f64::NAN;
    }

    let mut normalized = None;
    if let Some(dot) = dot {
        let sign_width = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
        let missing_integer = dot == sign_width;
        let missing_fraction = !bytes.get(dot + 1).is_some_and(u8::is_ascii_digit);
        if missing_integer || missing_fraction {
            let mut text = String::with_capacity(trimmed.len() + 2);
            text.push_str(&trimmed[..dot]);
            if missing_integer {
                text.push('0');
            }
            text.push('.');
            if missing_fraction {
                text.push('0');
            }
            text.push_str(&trimmed[dot + 1..]);
            normalized = Some(text);
        }
    }
    normalized
        .as_deref()
        .unwrap_or(trimmed)
        .parse::<f64>()
        .unwrap_or(f64::NAN)
}

pub fn number_parse_float(value: &JsString) -> f64 {
    let trimmed = value.trim_start_matches(javascript_whitespace);
    let bytes = trimmed.as_bytes();
    let mut index = 0usize;
    let negative = if bytes.get(index) == Some(&b'-') {
        index += 1;
        true
    } else {
        if bytes.get(index) == Some(&b'+') {
            index += 1;
        }
        false
    };
    if bytes[index..].starts_with(b"Infinity") {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }

    let start = 0usize;
    let mut integer_digits = 0usize;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
        integer_digits += 1;
    }
    let mut fraction_digits = 0usize;
    if bytes.get(index) == Some(&b'.') {
        let mut next = index + 1;
        while bytes.get(next).is_some_and(u8::is_ascii_digit) {
            next += 1;
            fraction_digits += 1;
        }
        if integer_digits > 0 || fraction_digits > 0 {
            index = next;
        }
    }
    if integer_digits == 0 && fraction_digits == 0 {
        return f64::NAN;
    }

    let mut end = index;
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        let mut next = index + 1;
        if matches!(bytes.get(next), Some(b'+' | b'-')) {
            next += 1;
        }
        let exponent_start = next;
        while bytes.get(next).is_some_and(u8::is_ascii_digit) {
            next += 1;
        }
        if next > exponent_start {
            end = next;
        }
    }
    trimmed[start..end].parse::<f64>().unwrap_or(f64::NAN)
}
