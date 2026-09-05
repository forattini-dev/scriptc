// Number-from-string grammars: parseInt, ToNumber(string), parseFloat.
// Split from strings_and_process.rs; included by lib.rs beside it.

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
