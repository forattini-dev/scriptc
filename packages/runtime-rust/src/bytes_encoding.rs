pub fn atomics_wait(bytes: &JsBytes<i32>, index: f64, expected: f64, timeout_ms: f64) -> JsString {
    if bytes_get(bytes, index) != f64::from(to_int32(expected)) {
        return string("not-equal");
    }
    if timeout_ms.is_finite() && timeout_ms > 0.0 {
        std::thread::sleep(std::time::Duration::from_secs_f64(timeout_ms / 1000.0));
    }
    string("timed-out")
}

fn bytes_relative_index(index: f64, length: usize, default: usize) -> usize {
    if index.is_nan() {
        return 0;
    }
    if index == f64::INFINITY {
        return length;
    }
    if index == f64::NEG_INFINITY {
        return 0;
    }
    let index = index.trunc();
    if index < 0.0 {
        (length as f64 + index).max(0.0) as usize
    } else if index.is_finite() {
        index.min(length as f64) as usize
    } else {
        default
    }
}

pub fn bytes_slice<T: ByteElement>(
    bytes: &JsBytes<T>,
    start: f64,
    end: f64,
    view: bool,
) -> JsBytes<T> {
    bytes.with(|data| {
        let start = bytes_relative_index(start, data.length, 0);
        let end = bytes_relative_index(end, data.length, data.length).max(start);
        if view {
            Gc::new(BytesData {
                storage: data.storage.clone(),
                offset: data.offset + start,
                length: end - start,
            })
        } else {
            let copied = data.storage.borrow()[data.offset + start..data.offset + end].to_vec();
            Gc::new(BytesData {
                length: copied.len(),
                storage: Rc::new(RefCell::new(copied)),
                offset: 0,
            })
        }
    })
}

pub fn bytes_byte_offset(bytes: &JsBytes<u8>) -> f64 {
    bytes.with(|data| data.offset as f64)
}

fn data_view_index(value: f64) -> Option<usize> {
    let value = if value.is_nan() { 0.0 } else { value.trunc() };
    (value.is_finite() && value >= 0.0 && value <= usize::MAX as f64).then_some(value as usize)
}

pub fn data_view_new(
    bytes: &JsBytes<u8>,
    byte_offset: f64,
    has_length: bool,
    byte_length: f64,
) -> JsBytes<u8> {
    let total = bytes.with(|data| data.length);
    let Some(start) = data_view_index(byte_offset) else {
        throw_range_error(format!(
            "Start offset {} is outside the bounds of the buffer",
            format_number(byte_offset)
        ));
    };
    if start > total {
        throw_range_error(format!(
            "Start offset {} is outside the bounds of the buffer",
            format_number(byte_offset)
        ));
    }
    let length = if has_length {
        let Some(length) = data_view_index(byte_length) else {
            throw_range_error(format!(
                "Invalid DataView length {}",
                format_number(byte_length)
            ));
        };
        if length > total - start {
            throw_range_error(format!(
                "Invalid DataView length {}",
                format_number(byte_length)
            ));
        }
        length
    } else {
        total - start
    };
    bytes.with(|data| {
        Gc::new(BytesData {
            storage: data.storage.clone(),
            offset: data.offset + start,
            length,
        })
    })
}

fn data_view_width(kind: &str) -> usize {
    match kind {
        "u8" | "i8" => 1,
        "u16" | "i16" => 2,
        "u32" | "i32" | "f32" => 4,
        "u64" | "i64" | "f64" => 8,
        _ => panic!("scriptc: invalid DataView numeric kind"),
    }
}

fn data_view_offset(bytes: &JsBytes<u8>, value: f64, width: usize) -> usize {
    let length = bytes.with(|data| data.length);
    let offset = data_view_index(value);
    if offset.is_none_or(|offset| offset > length || width > length - offset) {
        throw_range_error("Offset is outside the bounds of the DataView".to_owned());
    }
    offset.expect("validated DataView offset")
}

pub fn data_view_get(
    bytes: &JsBytes<u8>,
    kind: &str,
    byte_offset: f64,
    little_endian: bool,
) -> f64 {
    let width = data_view_width(kind);
    let offset = data_view_offset(bytes, byte_offset, width);
    if kind == "u64" || kind == "i64" {
        let value = bytes_read_unsigned(bytes, offset, width, little_endian);
        return if kind == "i64" {
            (value as i64) as f64
        } else {
            value as f64
        };
    }
    let endian = if little_endian { "le" } else { "be" };
    let token = match kind {
        "u8" | "i8" => kind.to_owned(),
        _ => format!("{kind}{endian}"),
    };
    bytes_read_num(bytes, &token, offset as f64)
}

pub fn data_view_set(
    bytes: &JsBytes<u8>,
    kind: &str,
    byte_offset: f64,
    value: f64,
    little_endian: bool,
) {
    let width = data_view_width(kind);
    let offset = data_view_offset(bytes, byte_offset, width);
    let bits = match kind {
        "u8" | "i8" | "u16" | "i16" | "u32" | "i32" => u64::from(to_uint32(value)),
        "f32" => u64::from((value as f32).to_bits()),
        "f64" => value.to_bits(),
        _ => panic!("scriptc: invalid DataView setter kind"),
    };
    bytes_write_unsigned(bytes, offset, width, little_endian, bits);
}

pub fn bytes_set_from<T: ByteElement>(target: &JsBytes<T>, source: &JsBytes<T>, offset: f64) {
    let offset = if offset.is_nan() { 0.0 } else { offset.trunc() };
    let target_length = target.with(|data| data.length);
    let source_values =
        source.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    if offset < 0.0
        || !offset.is_finite()
        || offset > target_length as f64
        || source_values.len() > target_length - offset as usize
    {
        throw_range_error("offset is out of bounds".to_owned());
    }
    target.with(|data| {
        let start = data.offset + offset as usize;
        data.storage.borrow_mut()[start..start + source_values.len()]
            .copy_from_slice(&source_values);
    });
}

fn decode_bytes(values: &[u8], encoding: &str) -> JsString {
    match encoding {
        "hex" => {
            let mut output = String::with_capacity(values.len() * 2);
            for byte in values {
                use std::fmt::Write;
                let _ = write!(output, "{byte:02x}");
            }
            Rc::from(output)
        }
        "base64" => Rc::from(bytes_base64_encode(values)),
        "base64url" => Rc::from(
            bytes_base64_encode(values)
                .replace('+', "-")
                .replace('/', "_")
                .trim_end_matches('=')
                .to_owned(),
        ),
        "utf8" | "utf-8" => Rc::from(String::from_utf8_lossy(values).as_ref()),
        "utf16le" => {
            let units: Vec<u16> = values
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Rc::from(String::from_utf16_lossy(&units))
        }
        "latin1" => Rc::from(
            values
                .iter()
                .map(|byte| char::from(*byte))
                .collect::<String>(),
        ),
        "ascii" => Rc::from(
            values
                .iter()
                .map(|byte| char::from(*byte & 0x7f))
                .collect::<String>(),
        ),
        other => throw_type_error(format!("Unknown encoding: {other}")),
    }
}

fn bytes_decode_index(index: f64, length: usize) -> usize {
    if index.is_nan() || index <= 0.0 {
        0
    } else if index >= length as f64 {
        length
    } else {
        index.trunc() as usize
    }
}

fn bytes_decode_bounds(length: usize, start: f64, end: f64) -> (usize, usize) {
    let start = bytes_decode_index(start, length);
    let end = bytes_decode_index(end, length).max(start);
    (start, end)
}

fn normalize_buffer_encoding(encoding: &str) -> Option<&'static str> {
    if encoding.eq_ignore_ascii_case("utf8") || encoding.eq_ignore_ascii_case("utf-8") {
        Some("utf8")
    } else if encoding.eq_ignore_ascii_case("hex") {
        Some("hex")
    } else if encoding.eq_ignore_ascii_case("base64") {
        Some("base64")
    } else if encoding.eq_ignore_ascii_case("base64url") {
        Some("base64url")
    } else if encoding.eq_ignore_ascii_case("latin1") || encoding.eq_ignore_ascii_case("binary") {
        Some("latin1")
    } else if encoding.eq_ignore_ascii_case("ascii") {
        Some("ascii")
    } else if encoding.eq_ignore_ascii_case("utf16le")
        || encoding.eq_ignore_ascii_case("utf-16le")
        || encoding.eq_ignore_ascii_case("ucs2")
        || encoding.eq_ignore_ascii_case("ucs-2")
    {
        Some("utf16le")
    } else {
        None
    }
}

fn checked_buffer_encoding(encoding: &JsString) -> &'static str {
    normalize_buffer_encoding(encoding).unwrap_or_else(|| {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "TypeError".to_owned(),
            message: format!("Unknown encoding: {encoding}"),
            code: Some("ERR_UNKNOWN_ENCODING".to_owned()),
            dom: None,
        })
    })
}

pub fn bytes_to_string(bytes: &JsBytes<u8>, encoding: &JsString) -> JsString {
    bytes_to_string_range(bytes, encoding, 0.0, f64::INFINITY)
}

pub fn bytes_to_string_range(
    bytes: &JsBytes<u8>,
    encoding: &JsString,
    start: f64,
    end: f64,
) -> JsString {
    bytes.with(|data| {
        let (start, end) = bytes_decode_bounds(data.length, start, end);
        let storage = data.storage.borrow();
        decode_bytes(
            &storage[data.offset + start..data.offset + end],
            encoding.as_ref(),
        )
    })
}

pub fn bytes_to_string_checked(bytes: &JsBytes<u8>, encoding: &JsString) -> JsString {
    if bytes.with(|data| data.length) == 0 {
        return empty_string();
    }
    let encoding = checked_buffer_encoding(encoding);
    bytes_to_string(bytes, &string(encoding))
}

pub fn bytes_to_string_checked_range(
    bytes: &JsBytes<u8>,
    encoding: &JsString,
    start: f64,
    end: f64,
) -> JsString {
    let (start, end) = bytes.with(|data| bytes_decode_bounds(data.length, start, end));
    if start == end {
        return empty_string();
    }
    let encoding = checked_buffer_encoding(encoding);
    bytes_to_string_range(bytes, &string(encoding), start as f64, end as f64)
}

fn string_decoder_unpack(pending: f64) -> Vec<u8> {
    let packed = pending as u32;
    let length = (packed & 0xff).min(3) as usize;
    (0..length)
        .map(|index| (packed >> (8 * (index + 1))) as u8)
        .collect()
}

fn string_decoder_pack(bytes: &[u8]) -> f64 {
    let mut packed = bytes.len().min(3) as u32;
    for (index, byte) in bytes.iter().take(3).enumerate() {
        packed |= u32::from(*byte) << (8 * (index + 1));
    }
    f64::from(packed)
}

fn string_decoder_combined(pending: f64, chunk: &JsBytes<u8>) -> Vec<u8> {
    let mut combined = string_decoder_unpack(pending);
    combined.extend(bytes_u8_values(chunk));
    combined
}

fn string_decoder_utf8_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let needed = if byte & 0xe0 == 0xc0 {
            2
        } else if byte & 0xf0 == 0xe0 {
            3
        } else if byte & 0xf8 == 0xf0 {
            4
        } else {
            return 0;
        };
        return usize::from(back < needed) * back;
    }
    0
}

fn string_decoder_base64(values: &[u8], url: bool) -> JsString {
    let output = bytes_base64_encode(values);
    if url {
        Rc::from(
            output
                .replace('+', "-")
                .replace('/', "_")
                .trim_end_matches('=')
                .to_owned(),
        )
    } else {
        Rc::from(output)
    }
}

fn string_decoder_utf16_step(pending: f64, chunk: &JsBytes<u8>) -> (JsString, f64) {
    let held = string_decoder_unpack(pending);
    let chunk = bytes_u8_values(chunk);
    let mut complete = Vec::with_capacity(4);
    let mut offset = 0;
    if !held.is_empty() {
        let total = if held.len() == 1 { 2 } else { 4 };
        let needed = total - held.len();
        if chunk.len() < needed {
            let mut next = held;
            next.extend_from_slice(&chunk);
            return (empty_string(), string_decoder_pack(&next));
        }
        complete.extend_from_slice(&held);
        complete.extend_from_slice(&chunk[..needed]);
        offset = needed;
    }
    let rest = &chunk[offset..];
    let keep = if rest.len() % 2 == 1 {
        rest.len() - 1
    } else if rest.len() >= 2 {
        let last = u16::from_le_bytes([rest[rest.len() - 2], rest[rest.len() - 1]]);
        if (0xd800..=0xdbff).contains(&last) {
            rest.len() - 2
        } else {
            rest.len()
        }
    } else {
        0
    };
    let next = string_decoder_pack(&rest[keep..]);
    complete.extend_from_slice(&rest[..keep]);
    (decode_bytes(&complete, "utf16le"), next)
}

fn string_decoder_step(encoding: &JsString, pending: f64, chunk: &JsBytes<u8>) -> (JsString, f64) {
    match encoding.as_ref() {
        "utf16le" => string_decoder_utf16_step(pending, chunk),
        "base64" | "base64url" => {
            let combined = string_decoder_combined(pending, chunk);
            let tail = combined.len() % 3;
            let complete = combined.len() - tail;
            (
                string_decoder_base64(&combined[..complete], encoding.as_ref() == "base64url"),
                string_decoder_pack(&combined[complete..]),
            )
        }
        "latin1" | "ascii" | "hex" => {
            let values = bytes_u8_values(chunk);
            (decode_bytes(&values, encoding), 0.0)
        }
        "utf8" | "utf-8" => {
            let combined = string_decoder_combined(pending, chunk);
            let tail = string_decoder_utf8_tail(&combined);
            let complete = combined.len() - tail;
            (
                decode_bytes(&combined[..complete], "utf8"),
                string_decoder_pack(&combined[complete..]),
            )
        }
        other => panic!("scriptc: invalid canonical StringDecoder encoding '{other}'"),
    }
}

pub fn string_decoder_write(encoding: &JsString, pending: f64, chunk: &JsBytes<u8>) -> JsString {
    string_decoder_step(encoding, pending, chunk).0
}

pub fn string_decoder_next(encoding: &JsString, pending: f64, chunk: &JsBytes<u8>) -> f64 {
    string_decoder_step(encoding, pending, chunk).1
}

pub fn string_decoder_end(encoding: &JsString, pending: f64) -> JsString {
    let pending = string_decoder_unpack(pending);
    match encoding.as_ref() {
        "base64" => string_decoder_base64(&pending, false),
        "base64url" => string_decoder_base64(&pending, true),
        "utf16le" => decode_bytes(&pending, "utf16le"),
        "latin1" | "ascii" | "hex" => empty_string(),
        "utf8" | "utf-8" => decode_bytes(&pending, "utf8"),
        other => panic!("scriptc: invalid canonical StringDecoder encoding '{other}'"),
    }
}

fn bytes_from_vec(values: Vec<u8>) -> JsBytes<u8> {
    Gc::new(BytesData {
        length: values.len(),
        storage: Rc::new(RefCell::new(values)),
        offset: 0,
    })
}

fn bytes_hex_decode(text: &str) -> Vec<u8> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let mut output = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().chunks_exact(2) {
        let (Some(high), Some(low)) = (nibble(pair[0]), nibble(pair[1])) else {
            break;
        };
        output.push((high << 4) | low);
    }
    output
}

fn bytes_base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

fn bytes_base64_decode(text: &str) -> Vec<u8> {
    let values: Vec<u8> = text
        .bytes()
        .take_while(|byte| *byte != b'=')
        .filter_map(bytes_base64_value)
        .collect();
    let mut output = Vec::with_capacity(values.len() * 3 / 4);
    for chunk in values.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        output.push((chunk[0] << 2) | (chunk[1] >> 4));
        if chunk.len() >= 3 {
            output.push((chunk[1] << 4) | (chunk[2] >> 2));
        }
        if chunk.len() == 4 {
            output.push((chunk[2] << 6) | chunk[3]);
        }
    }
    output
}

fn bytes_base64_encode(values: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(values.len().div_ceil(3) * 4);
    for chunk in values.chunks(3) {
        output.push(char::from(ALPHABET[(chunk[0] >> 2) as usize]));
        output.push(char::from(
            ALPHABET[((chunk[0] & 3) << 4 | chunk.get(1).copied().unwrap_or(0) >> 4) as usize],
        ));
        if let Some(second) = chunk.get(1) {
            output.push(char::from(
                ALPHABET[((second & 15) << 2 | chunk.get(2).copied().unwrap_or(0) >> 6) as usize],
            ));
        } else {
            output.push('=');
        }
        if let Some(third) = chunk.get(2) {
            output.push(char::from(ALPHABET[(third & 63) as usize]));
        } else {
            output.push('=');
        }
    }
    output
}

fn buffer_string_bytes(value: &JsString, encoding: &JsString) -> Vec<u8> {
    match encoding.as_ref() {
        "hex" => bytes_hex_decode(value),
        "base64" | "base64url" => bytes_base64_decode(value),
        "utf8" | "utf-8" => value.as_bytes().to_vec(),
        "utf16le" => value.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        "latin1" | "ascii" => value.encode_utf16().map(|unit| unit as u8).collect(),
        other => throw_type_error(format!("Unknown encoding: {other}")),
    }
}

pub fn buffer_from_string(value: &JsString, encoding: &JsString) -> JsBytes<u8> {
    bytes_from_vec(buffer_string_bytes(value, encoding))
}

pub fn buffer_concat(values: &JsArray<JsBytes<u8>>) -> JsBytes<u8> {
    let mut output = Vec::new();
    values.with(|array| {
        for bytes in &array.elements {
            bytes.with(|data| {
                output.extend_from_slice(
                    &data.storage.borrow()[data.offset..data.offset + data.length],
                );
            });
        }
    });
    bytes_from_vec(output)
}

pub fn buffer_concat_len(values: &JsArray<JsBytes<u8>>, total: f64) -> JsBytes<u8> {
    if array_len(values) == 0.0 {
        return bytes_empty();
    }
    bytes_validate_offset("length", total, 9_007_199_254_740_991.0);
    let mut output = vec![0; total as usize];
    let mut offset = 0;
    values.with(|array| {
        for bytes in &array.elements {
            if offset == output.len() {
                break;
            }
            let part = bytes_u8_values(bytes);
            let count = part.len().min(output.len() - offset);
            output[offset..offset + count].copy_from_slice(&part[..count]);
            offset += count;
        }
    });
    bytes_from_vec(output)
}

pub fn buffer_byte_length_string(value: &JsString, encoding: &JsString) -> f64 {
    let units: Vec<u16> = value.encode_utf16().collect();
    match encoding.as_ref() {
        "latin1" | "ascii" => units.len() as f64,
        "utf16le" => (units.len() * 2) as f64,
        "hex" => (units.len() / 2) as f64,
        "base64" | "base64url" => {
            let mut length = units.len();
            if units.get(length.wrapping_sub(1)) == Some(&u16::from(b'=')) {
                length -= 1;
            }
            if units.get(length.wrapping_sub(1)) == Some(&u16::from(b'=')) {
                length -= 1;
            }
            ((length * 3) >> 2) as f64
        }
        "utf8" | "utf-8" => value.len() as f64,
        other => panic!("scriptc: invalid canonical Buffer encoding '{other}'"),
    }
}

pub fn buffer_is_encoding(value: &JsString) -> bool {
    normalize_buffer_encoding(value).is_some()
}

fn bytes_num_width(kind: &str) -> usize {
    match kind {
        "u8" | "i8" => 1,
        "u16be" | "u16le" | "i16be" | "i16le" => 2,
        "u32be" | "u32le" | "i32be" | "i32le" | "f32be" | "f32le" => 4,
        "f64be" | "f64le" => 8,
        _ => panic!("scriptc: invalid bytes numeric kind"),
    }
}

fn bytes_bounds_error(value: f64, length: f64, value_name: Option<&str>) -> ! {
    if value.floor() != value {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "RangeError".to_owned(),
            message: format!(
                "The value of \"{}\" is out of range. It must be an integer. Received {}",
                value_name.unwrap_or("offset"),
                bytes_received_number(value)
            ),
            code: Some("ERR_OUT_OF_RANGE".to_owned()),
            dom: None,
        });
    }
    if length < 0.0 {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "RangeError".to_owned(),
            message: "Attempt to access memory outside buffer bounds".to_owned(),
            code: Some("ERR_BUFFER_OUT_OF_BOUNDS".to_owned()),
            dom: None,
        });
    }
    throw_value(JsError {
        identity: Rc::new(()),
        name: "RangeError".to_owned(),
        message: format!(
            "The value of \"{}\" is out of range. It must be >= {} and <= {}. Received {}",
            value_name.unwrap_or("offset"),
            usize::from(value_name.is_some()),
            format_number(length),
            bytes_received_number(value)
        ),
        code: Some("ERR_OUT_OF_RANGE".to_owned()),
        dom: None,
    })
}

fn bytes_num_offset(bytes: &JsBytes<u8>, offset: f64, width: usize) -> usize {
    let capacity = bytes.with(|data| data.length as f64) - width as f64;
    if offset.floor() != offset || capacity < 0.0 || offset < 0.0 || offset > capacity {
        bytes_bounds_error(offset, capacity, None);
    }
    offset as usize
}

fn bytes_check_int(
    bytes: &JsBytes<u8>,
    value: f64,
    offset: f64,
    width: usize,
    signed: bool,
) -> usize {
    let exponent = width * 8 - usize::from(signed);
    let limit = 2_f64.powi(exponent as i32);
    let (minimum, maximum) = if signed {
        (-limit, limit - 1.0)
    } else {
        (0.0, limit - 1.0)
    };
    if value > maximum || value < minimum {
        let requirement = if width > 4 {
            if signed {
                format!(">= -(2 ** {exponent}) and < 2 ** {exponent}")
            } else {
                format!(">= 0 and < 2 ** {exponent}")
            }
        } else {
            format!(
                ">= {} and <= {}",
                format_number(minimum),
                format_number(maximum)
            )
        };
        throw_value(JsError {
            identity: Rc::new(()),
            name: "RangeError".to_owned(),
            message: format!(
                "The value of \"value\" is out of range. It must be {requirement}. Received {}",
                bytes_received_number(value)
            ),
            code: Some("ERR_OUT_OF_RANGE".to_owned()),
            dom: None,
        });
    }
    bytes_num_offset(bytes, offset, width)
}

fn bytes_read_unsigned(
    bytes: &JsBytes<u8>,
    offset: usize,
    width: usize,
    little_endian: bool,
) -> u64 {
    bytes.with(|data| {
        let storage = data.storage.borrow();
        let input = &storage[data.offset + offset..data.offset + offset + width];
        let mut value = 0_u64;
        for index in 0..width {
            value |= u64::from(
                input[if little_endian {
                    index
                } else {
                    width - 1 - index
                }],
            ) << (8 * index);
        }
        value
    })
}

fn bytes_write_unsigned(
    bytes: &JsBytes<u8>,
    offset: usize,
    width: usize,
    little_endian: bool,
    value: u64,
) {
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let output = &mut storage[data.offset + offset..data.offset + offset + width];
        for index in 0..width {
            output[if little_endian {
                index
            } else {
                width - 1 - index
            }] = (value >> (8 * index)) as u8;
        }
    });
}

pub fn bytes_read_num(bytes: &JsBytes<u8>, kind: &str, offset: f64) -> f64 {
    let width = bytes_num_width(kind);
    let offset = bytes_num_offset(bytes, offset, width);
    bytes.with(|data| {
        let storage = data.storage.borrow();
        let input = &storage[data.offset + offset..data.offset + offset + width];
        match kind {
            "u8" => f64::from(input[0]),
            "i8" => f64::from(input[0] as i8),
            "u16be" => f64::from(u16::from_be_bytes([input[0], input[1]])),
            "u16le" => f64::from(u16::from_le_bytes([input[0], input[1]])),
            "i16be" => f64::from(i16::from_be_bytes([input[0], input[1]])),
            "i16le" => f64::from(i16::from_le_bytes([input[0], input[1]])),
            "u32be" => f64::from(u32::from_be_bytes(input.try_into().expect("four bytes"))),
            "u32le" => f64::from(u32::from_le_bytes(input.try_into().expect("four bytes"))),
            "i32be" => f64::from(i32::from_be_bytes(input.try_into().expect("four bytes"))),
            "i32le" => f64::from(i32::from_le_bytes(input.try_into().expect("four bytes"))),
            "f32be" => f64::from(f32::from_be_bytes(input.try_into().expect("four bytes"))),
            "f32le" => f64::from(f32::from_le_bytes(input.try_into().expect("four bytes"))),
            "f64be" => f64::from_be_bytes(input.try_into().expect("eight bytes")),
            "f64le" => f64::from_le_bytes(input.try_into().expect("eight bytes")),
            _ => unreachable!(),
        }
    })
}

pub fn bytes_write_num(bytes: &JsBytes<u8>, kind: &str, value: f64, offset: f64) -> f64 {
    let width = bytes_num_width(kind);
    let integer = !matches!(kind, "f32be" | "f32le" | "f64be" | "f64le");
    let signed = matches!(kind, "i8" | "i16be" | "i16le" | "i32be" | "i32le");
    let offset = if integer {
        bytes_check_int(bytes, value, offset, width, signed)
    } else {
        bytes_num_offset(bytes, offset, width)
    };
    let bits = match kind {
        "u8" | "u16be" | "u16le" | "u32be" | "u32le" | "i8" | "i16be" | "i16le" | "i32be"
        | "i32le" => (if value.is_nan() {
            0
        } else {
            value.trunc() as i64
        } as u64)
            .to_be_bytes(),
        "f32be" | "f32le" => u64::from((value as f32).to_bits()).to_be_bytes(),
        "f64be" | "f64le" => value.to_bits().to_be_bytes(),
        _ => unreachable!(),
    };
    let source = &bits[8 - width..];
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let output = &mut storage[data.offset + offset..data.offset + offset + width];
        if kind.ends_with("le") {
            for (target, source) in output.iter_mut().zip(source.iter().rev()) {
                *target = *source;
            }
        } else {
            output.copy_from_slice(source);
        }
    });
    (offset + width) as f64
}

fn bytes_num_var_kind(kind: &str) -> (bool, bool) {
    match kind {
        "ube" => (false, false),
        "ule" => (false, true),
        "ibe" => (true, false),
        "ile" => (true, true),
        _ => panic!("scriptc: invalid variable-width bytes numeric kind"),
    }
}

fn bytes_num_var_width(byte_length: f64) -> usize {
    if byte_length.floor() != byte_length || !(1.0..=6.0).contains(&byte_length) {
        bytes_bounds_error(byte_length, 6.0, Some("byteLength"));
    }
    byte_length as usize
}

pub fn bytes_read_num_var(bytes: &JsBytes<u8>, kind: &str, offset: f64, byte_length: f64) -> f64 {
    let width = bytes_num_var_width(byte_length);
    let offset = bytes_num_offset(bytes, offset, width);
    let (signed, little_endian) = bytes_num_var_kind(kind);
    let value = bytes_read_unsigned(bytes, offset, width, little_endian);
    if signed && value & (1_u64 << (width * 8 - 1)) != 0 {
        (value as i64 - (1_i64 << (width * 8))) as f64
    } else {
        value as f64
    }
}

pub fn bytes_write_num_var(
    bytes: &JsBytes<u8>,
    kind: &str,
    value: f64,
    offset: f64,
    byte_length: f64,
) -> f64 {
    let width = bytes_num_var_width(byte_length);
    let (signed, little_endian) = bytes_num_var_kind(kind);
    let offset = bytes_check_int(bytes, value, offset, width, signed);
    let value = if value.is_nan() {
        0
    } else {
        value.trunc() as i64
    } as u64;
    bytes_write_unsigned(bytes, offset, width, little_endian, value);
    (offset + width) as f64
}
