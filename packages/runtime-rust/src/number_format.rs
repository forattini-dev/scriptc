pub fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == f64::INFINITY {
        return "Infinity".to_owned();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let scientific = format!("{value:e}");
        let (mantissa, exponent) = scientific
            .split_once('e')
            .expect("scriptc: Rust scientific number without an exponent");
        let exponent = exponent
            .parse::<i32>()
            .expect("scriptc: invalid Rust scientific exponent");
        return format!(
            "{mantissa}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        );
    }
    value.to_string()
}

pub fn display_string(value: &JsString) -> String {
    value.to_string()
}

pub fn display_number(value: f64) -> String {
    if value == 0.0 && value.is_sign_negative() {
        "-0".to_owned()
    } else {
        format_number(value)
    }
}

pub fn display_bool(value: bool) -> String {
    if value { "true" } else { "false" }.to_owned()
}

pub fn number_same_value(left: f64, right: f64) -> bool {
    if left.is_nan() && right.is_nan() {
        return true;
    }
    if left == 0.0 && right == 0.0 {
        return left.is_sign_negative() == right.is_sign_negative();
    }
    left == right
}

pub fn math_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_positive() || right.is_sign_positive() {
            0.0
        } else {
            -0.0
        };
    }
    if left > right { left } else { right }
}

pub fn math_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() || right.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if left < right { left } else { right }
}

pub fn math_max_array(values: &JsArray<f64>) -> f64 {
    values.with(|values| {
        values
            .elements
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, math_max)
    })
}

pub fn math_min_array(values: &JsArray<f64>) -> f64 {
    values.with(|values| {
        values
            .elements
            .iter()
            .copied()
            .fold(f64::INFINITY, math_min)
    })
}

pub fn math_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() || value == 0.0 {
        return value;
    }
    let floor = value.floor();
    let rounded = if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}

pub fn math_sign(value: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        value
    } else {
        1.0_f64.copysign(value)
    }
}

pub fn math_pow(base: f64, exponent: f64) -> f64 {
    // Rust/libm follows C for this special case, while ECMAScript's
    // Number::exponentiate returns NaN for either ±1 raised to ±Infinity.
    if exponent.is_infinite() && base.abs() == 1.0 {
        f64::NAN
    } else {
        base.powf(exponent)
    }
}

#[derive(Clone)]
struct FixedInteger {
    limbs: Vec<u32>,
}

impl FixedInteger {
    fn from_u64(value: u64) -> Self {
        let mut result = Self {
            limbs: vec![value as u32, (value >> 32) as u32],
        };
        result.normalize();
        result
    }

    fn normalize(&mut self) {
        while self.limbs.len() > 1 && self.limbs.last() == Some(&0) {
            self.limbs.pop();
        }
    }

    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        match self.limbs.len().cmp(&other.limbs.len()) {
            std::cmp::Ordering::Equal => self.limbs.iter().rev().cmp(other.limbs.iter().rev()),
            ordering => ordering,
        }
    }

    fn subtract_assign(&mut self, other: &Self) {
        assert!(self.compare(other) != std::cmp::Ordering::Less);
        let mut borrow = 0_i64;
        for index in 0..self.limbs.len() {
            let difference = i64::from(self.limbs[index])
                - i64::from(other.limbs.get(index).copied().unwrap_or(0))
                - borrow;
            if difference < 0 {
                self.limbs[index] = (difference + (1_i64 << 32)) as u32;
                borrow = 1;
            } else {
                self.limbs[index] = difference as u32;
                borrow = 0;
            }
        }
        assert_eq!(borrow, 0);
        self.normalize();
    }

    fn multiply_small(&mut self, multiplier: u32) {
        let mut carry = 0_u64;
        for limb in &mut self.limbs {
            let product = u64::from(*limb) * u64::from(multiplier) + carry;
            *limb = product as u32;
            carry = product >> 32;
        }
        if carry != 0 {
            self.limbs.push(carry as u32);
        }
        self.normalize();
    }

    fn multiply_by_five(&mut self) {
        self.multiply_small(5);
    }

    fn bit(&self, bit: usize) -> bool {
        let word = bit / 32;
        self.limbs
            .get(word)
            .is_some_and(|limb| ((limb >> (bit % 32)) & 1) != 0)
    }

    fn shift_right(&mut self, bits: usize) {
        let words = bits / 32;
        let remainder = bits % 32;
        if words >= self.limbs.len() {
            self.limbs.clear();
            self.limbs.push(0);
            return;
        }
        let count = self.limbs.len() - words;
        let mut output = Vec::with_capacity(count);
        for index in 0..count {
            let low = self.limbs[index + words] >> remainder;
            let high = if remainder != 0 && index + words + 1 < self.limbs.len() {
                self.limbs[index + words + 1] << (32 - remainder)
            } else {
                0
            };
            output.push(low | high);
        }
        self.limbs = output;
        self.normalize();
    }

    fn shift_left(&mut self, bits: usize) {
        let words = bits / 32;
        let remainder = bits % 32;
        let mut output = vec![0_u32; self.limbs.len() + words + usize::from(remainder != 0)];
        for (index, limb) in self.limbs.iter().copied().enumerate() {
            let target = index + words;
            output[target] |= limb << remainder;
            if remainder != 0 {
                output[target + 1] |= limb >> (32 - remainder);
            }
        }
        self.limbs = output;
        self.normalize();
    }

    fn increment(&mut self) {
        let mut carry = 1_u64;
        for limb in &mut self.limbs {
            if carry == 0 {
                break;
            }
            let sum = u64::from(*limb) + carry;
            *limb = sum as u32;
            carry = sum >> 32;
        }
        if carry != 0 {
            self.limbs.push(carry as u32);
        }
    }

    fn set_bit(&mut self, bit: usize) {
        let word = bit / 32;
        self.limbs.resize(self.limbs.len().max(word + 1), 0);
        self.limbs[word] |= 1_u32 << (bit % 32);
    }

    fn bit_length(&self) -> usize {
        if self.is_zero() {
            0
        } else {
            (self.limbs.len() - 1) * 32
                + (32 - self.limbs.last().copied().unwrap_or(0).leading_zeros()) as usize
        }
    }

    fn is_odd(&self) -> bool {
        self.limbs[0] & 1 != 0
    }

    fn divide_rem(&self, divisor: &Self) -> (Self, Self) {
        assert!(!divisor.is_zero());
        if self.compare(divisor) == std::cmp::Ordering::Less {
            return (Self::from_u64(0), self.clone());
        }
        let mut remainder = self.clone();
        let shift = remainder.bit_length() - divisor.bit_length();
        let mut shifted = divisor.clone();
        shifted.shift_left(shift);
        let mut quotient = Self::from_u64(0);
        for bit in (0..=shift).rev() {
            if remainder.compare(&shifted) != std::cmp::Ordering::Less {
                remainder.subtract_assign(&shifted);
                quotient.set_bit(bit);
            }
            shifted.shift_right(1);
        }
        quotient.normalize();
        (quotient, remainder)
    }

    fn divide_small(&mut self, divisor: u32) -> u32 {
        let mut remainder = 0_u64;
        for limb in self.limbs.iter_mut().rev() {
            let current = (remainder << 32) | u64::from(*limb);
            *limb = (current / u64::from(divisor)) as u32;
            remainder = current % u64::from(divisor);
        }
        self.normalize();
        remainder as u32
    }

    fn divide_by_billion(&mut self) -> u32 {
        self.divide_small(1_000_000_000)
    }

    fn is_zero(&self) -> bool {
        self.limbs.len() == 1 && self.limbs[0] == 0
    }

    fn to_radix_string(&self, radix: u32) -> String {
        const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        if self.is_zero() {
            return "0".to_owned();
        }
        let mut value = self.clone();
        let mut reversed = Vec::new();
        while !value.is_zero() {
            reversed.push(DIGITS[value.divide_small(radix) as usize]);
        }
        reversed.reverse();
        String::from_utf8(reversed).expect("scriptc: radix formatter emitted non-ASCII digits")
    }
}

fn positive_f64_ratio(value: f64) -> (FixedInteger, usize) {
    debug_assert!(value >= 0.0 && value.is_finite());
    let bits = value.to_bits();
    let ieee_exponent = ((bits >> 52) & 0x7ff) as i32;
    let mut mantissa = bits & ((1_u64 << 52) - 1);
    let binary_exponent = if ieee_exponent == 0 {
        -1074
    } else {
        mantissa |= 1_u64 << 52;
        ieee_exponent - 1023 - 52
    };
    let mut numerator = FixedInteger::from_u64(mantissa);
    if binary_exponent >= 0 {
        numerator.shift_left(binary_exponent as usize);
        (numerator, 0)
    } else {
        (numerator, (-binary_exponent) as usize)
    }
}

fn rounded_ratio(
    numerator: &FixedInteger,
    denominator: &FixedInteger,
    ties_up: bool,
) -> FixedInteger {
    let (mut quotient, remainder) = numerator.divide_rem(denominator);
    let mut twice_remainder = remainder;
    twice_remainder.shift_left(1);
    let comparison = twice_remainder.compare(denominator);
    if comparison == std::cmp::Ordering::Greater
        || (comparison == std::cmp::Ordering::Equal && (ties_up || quotient.is_odd()))
    {
        quotient.increment();
    }
    quotient
}

fn rounded_decimal_integer(value: f64, decimal_scale: i32) -> FixedInteger {
    let (mut numerator, denominator_bits) = positive_f64_ratio(value);
    let mut denominator = FixedInteger::from_u64(1);
    if decimal_scale >= 0 {
        for _ in 0..decimal_scale {
            numerator.multiply_by_five();
        }
        let binary_shift = decimal_scale - denominator_bits as i32;
        if binary_shift >= 0 {
            numerator.shift_left(binary_shift as usize);
        } else {
            denominator.shift_left((-binary_shift) as usize);
        }
    } else {
        let inverse_scale = -decimal_scale;
        for _ in 0..inverse_scale {
            denominator.multiply_by_five();
        }
        let binary_shift = -(denominator_bits as i32) - inverse_scale;
        if binary_shift >= 0 {
            numerator.shift_left(binary_shift as usize);
        } else {
            denominator.shift_left((-binary_shift) as usize);
        }
    }
    rounded_ratio(&numerator, &denominator, true)
}

fn decimal_exponent(value: f64) -> i32 {
    let plain = format_number(value);
    if let Some((_, exponent)) = plain.split_once('e') {
        return exponent
            .parse::<i32>()
            .expect("scriptc: formatted number has an invalid exponent");
    }
    if let Some(decimal) = plain.find('.') {
        if decimal != 1 || !plain.starts_with('0') {
            return decimal as i32 - 1;
        }
        let first = plain
            .bytes()
            .position(|digit| digit >= b'1' && digit <= b'9')
            .expect("scriptc: non-zero number formatted without a non-zero digit");
        return 1 - first as i32;
    }
    plain.len() as i32 - 1
}

fn shortest_decimal_digits(value: f64) -> (Vec<u8>, i32) {
    debug_assert!(value > 0.0 && value.is_finite());
    let rendered = format_number(value);
    if let Some((mantissa, exponent)) = rendered.split_once('e') {
        let mut digits = mantissa
            .bytes()
            .filter(|byte| *byte != b'.')
            .collect::<Vec<_>>();
        while digits.len() > 1 && digits.last() == Some(&b'0') {
            digits.pop();
        }
        let exponent = exponent
            .parse::<i32>()
            .expect("scriptc: shortest number has an invalid exponent");
        return (digits, exponent + 1);
    }

    if let Some(decimal) = rendered.find('.') {
        let bytes = rendered.as_bytes();
        if bytes[0] == b'0' {
            let first = bytes
                .iter()
                .position(|byte| byte.is_ascii_digit() && *byte != b'0')
                .expect("scriptc: non-zero shortest number has no non-zero digit");
            let mut digits = bytes[first..].to_vec();
            while digits.len() > 1 && digits.last() == Some(&b'0') {
                digits.pop();
            }
            return (digits, decimal as i32 - first as i32 + 1);
        }

        let mut digits = bytes
            .iter()
            .copied()
            .filter(|byte| *byte != b'.')
            .collect::<Vec<_>>();
        while digits.len() > 1 && digits.last() == Some(&b'0') {
            digits.pop();
        }
        return (digits, decimal as i32);
    }

    let exponent = rendered.len() as i32;
    let mut digits = rendered.into_bytes();
    while digits.len() > 1 && digits.last() == Some(&b'0') {
        digits.pop();
    }
    (digits, exponent)
}

fn increment_decimal_digits(digits: &mut Vec<u8>) -> bool {
    for digit in digits.iter_mut().rev() {
        if *digit != b'9' {
            *digit += 1;
            return false;
        }
        *digit = b'0';
    }
    digits.clear();
    digits.push(b'1');
    true
}

/// The embedded `en-US` default decimal formatter used by
/// `Intl.NumberFormat` and `Number.prototype.toLocaleString`.
pub fn intl_number_format_en_us(value: f64) -> JsString {
    if value.is_nan() {
        return string("NaN");
    }
    if value == f64::INFINITY {
        return string("∞");
    }
    if value == f64::NEG_INFINITY {
        return string("-∞");
    }

    let negative = value.is_sign_negative();
    if value == 0.0 {
        return string(if negative { "-0" } else { "0" });
    }

    let (mut digits, mut exponent) = shortest_decimal_digits(value.abs());
    let kept = exponent + 3;
    if kept < digits.len() as i32 {
        let round_up = kept >= 0 && digits[kept as usize] >= b'5';
        digits.truncate(kept.max(0) as usize);
        if round_up && increment_decimal_digits(&mut digits) {
            exponent += 1;
        } else if digits.is_empty() {
            return string(if negative { "-0" } else { "0" });
        }
    }

    let mut fraction = [b'0'; 3];
    for (offset, digit) in fraction.iter_mut().enumerate() {
        let index = exponent + offset as i32;
        if index >= 0 && index < digits.len() as i32 {
            *digit = digits[index as usize];
        }
    }
    let fraction_len = fraction
        .iter()
        .rposition(|digit| *digit != b'0')
        .map_or(0, |index| index + 1);

    let integer_digits = exponent.max(1) as usize;
    let grouping = integer_digits.saturating_sub(1) / 3;
    let mut output = String::with_capacity(
        usize::from(negative) + integer_digits + grouping + usize::from(fraction_len > 0) + fraction_len,
    );
    if negative {
        output.push('-');
    }
    if exponent <= 0 {
        output.push('0');
    } else {
        for index in 0..exponent as usize {
            if index > 0 && (exponent as usize - index) % 3 == 0 {
                output.push(',');
            }
            output.push(if index < digits.len() {
                digits[index] as char
            } else {
                '0'
            });
        }
    }
    if fraction_len > 0 {
        output.push('.');
        output.push_str(
            std::str::from_utf8(&fraction[..fraction_len])
                .expect("scriptc: Intl formatter emitted non-ASCII fraction digits"),
        );
    }
    Rc::from(output)
}

pub fn number_to_fixed(value: f64, fraction_digits: f64) -> JsString {
    let digits = if fraction_digits.is_nan() {
        0.0
    } else {
        fraction_digits.trunc()
    };
    if !(0.0..=100.0).contains(&digits) {
        throw_range_error("toFixed() digits argument must be between 0 and 100".to_owned());
    }
    let fraction_count = digits as usize;
    if !value.is_finite() || value.abs() >= 1e21 {
        return Rc::from(format_number(value));
    }

    let negative = value < 0.0;
    let magnitude = value.abs();
    let bits = magnitude.to_bits();
    let ieee_exponent = ((bits >> 52) & 0x7ff) as i32;
    let mut mantissa = bits & ((1_u64 << 52) - 1);
    let binary_exponent = if ieee_exponent == 0 {
        -1074
    } else {
        mantissa |= 1_u64 << 52;
        ieee_exponent - 1023 - 52
    };

    let mut integer = FixedInteger::from_u64(mantissa);
    for _ in 0..fraction_count {
        integer.multiply_by_five();
    }
    let shift = binary_exponent + fraction_count as i32;
    if shift >= 0 {
        integer.shift_left(shift as usize);
    } else {
        let right = (-shift) as usize;
        let round_up = integer.bit(right - 1);
        integer.shift_right(right);
        if round_up {
            integer.increment();
        }
    }

    let mut chunks = Vec::new();
    loop {
        chunks.push(integer.divide_by_billion());
        if integer.is_zero() {
            break;
        }
    }
    let mut decimal = chunks
        .pop()
        .expect("scriptc: fixed integer rendered without a chunk")
        .to_string();
    while let Some(chunk) = chunks.pop() {
        decimal.push_str(&format!("{chunk:09}"));
    }

    let padded = decimal.len().max(fraction_count + 1);
    let integer_digits = padded - fraction_count;
    let leading_zeros = padded - decimal.len();
    let mut output =
        String::with_capacity(padded + usize::from(fraction_count != 0) + usize::from(negative));
    if negative {
        output.push('-');
    }
    for index in 0..padded {
        if fraction_count != 0 && index == integer_digits {
            output.push('.');
        }
        output.push(if index < leading_zeros {
            '0'
        } else {
            decimal.as_bytes()[index - leading_zeros] as char
        });
    }
    Rc::from(output)
}

pub fn number_to_fixed_default(value: f64) -> JsString {
    number_to_fixed(value, 0.0)
}

pub fn number_to_exponential(value: f64) -> JsString {
    if value.is_nan() {
        return string("NaN");
    }
    if value == f64::INFINITY {
        return string("Infinity");
    }
    if value == f64::NEG_INFINITY {
        return string("-Infinity");
    }
    if value == 0.0 {
        return string("0e+0");
    }

    // The omitted-fractionDigits form uses the same shortest, closest,
    // round-tripping decimal digits as Number::toString. Re-place those
    // digits into scientific notation instead of asking Rust to round the
    // binary value a second time (which would change halfway cases).
    let negative = value < 0.0;
    let plain = format_number(value.abs());
    let (mut digits, exponent) = if let Some((mantissa, exponent)) = plain.split_once('e') {
        (
            mantissa.chars().filter(|ch| *ch != '.').collect::<String>(),
            exponent
                .parse::<i32>()
                .expect("scriptc: formatted number has an invalid exponent"),
        )
    } else if let Some(decimal) = plain.find('.') {
        let compact = plain.chars().filter(|ch| *ch != '.').collect::<String>();
        let first = compact
            .bytes()
            .position(|digit| digit != b'0')
            .expect("scriptc: non-zero number formatted without a non-zero digit");
        (
            compact[first..].to_owned(),
            decimal as i32 - first as i32 - 1,
        )
    } else {
        let exponent = plain.len() as i32 - 1;
        (plain, exponent)
    };
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }

    let mut output = String::with_capacity(digits.len() + 8 + usize::from(negative));
    if negative {
        output.push('-');
    }
    output.push(digits.as_bytes()[0] as char);
    if digits.len() > 1 {
        output.push('.');
        output.push_str(&digits[1..]);
    }
    output.push('e');
    if exponent >= 0 {
        output.push('+');
    }
    output.push_str(&exponent.to_string());
    Rc::from(output)
}

pub fn number_to_precision(value: f64, precision: f64) -> JsString {
    let precision = if precision.is_nan() {
        0.0
    } else {
        precision.trunc()
    };
    if !value.is_finite() {
        return Rc::from(format_number(value));
    }
    if !(1.0..=100.0).contains(&precision) {
        throw_range_error("toPrecision() argument must be between 1 and 100".to_owned());
    }
    let precision = precision as usize;
    let negative = value < 0.0;
    let magnitude = value.abs();
    let mut exponent = if magnitude == 0.0 {
        0
    } else {
        decimal_exponent(magnitude)
    };
    let mut digits = if magnitude == 0.0 {
        "0".repeat(precision)
    } else {
        let mut rounded = rounded_decimal_integer(magnitude, precision as i32 - exponent - 1);
        let mut rendered = rounded.to_radix_string(10);
        if rendered.len() > precision {
            assert_eq!(rounded.divide_small(10), 0);
            exponent += 1;
            rendered = rounded.to_radix_string(10);
        }
        while rendered.len() < precision {
            rendered.insert(0, '0');
        }
        rendered
    };

    let mut output = String::with_capacity(precision + exponent.unsigned_abs() as usize + 8);
    if negative {
        output.push('-');
    }
    if exponent < -6 || exponent >= precision as i32 {
        output.push(digits.remove(0));
        if !digits.is_empty() {
            output.push('.');
            output.push_str(&digits);
        }
        output.push('e');
        if exponent >= 0 {
            output.push('+');
        }
        output.push_str(&exponent.to_string());
    } else if exponent == precision as i32 - 1 {
        output.push_str(&digits);
    } else if exponent >= 0 {
        let split = exponent as usize + 1;
        output.push_str(&digits[..split]);
        output.push('.');
        output.push_str(&digits[split..]);
    } else {
        output.push_str("0.");
        for _ in 0..-exponent - 1 {
            output.push('0');
        }
        output.push_str(&digits);
    }
    Rc::from(output)
}

pub fn number_to_radix_string(value: f64, radix: f64) -> JsString {
    let radix = if radix.is_nan() { 0.0 } else { radix.trunc() };
    if !(2.0..=36.0).contains(&radix) {
        throw_range_error("toString() radix argument must be between 2 and 36".to_owned());
    }
    let radix = radix as u32;
    if radix == 10 {
        return Rc::from(format_number(value));
    }
    if value.is_nan() {
        return string("NaN");
    }
    if value == f64::INFINITY {
        return string("Infinity");
    }
    if value == f64::NEG_INFINITY {
        return string("-Infinity");
    }
    if value == 0.0 {
        return string("0");
    }

    // Match V8's implementation, including its observable choice among the
    // representations permitted by Number::toString for non-decimal radices.
    // The algorithm deliberately performs each digit step in binary64.
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    const CAPACITY: usize = 2200;
    let mut buffer = [0_u8; CAPACITY];
    let midpoint = CAPACITY / 2;
    let mut integer_cursor = midpoint;
    let mut fraction_cursor = midpoint;
    let negative = value < 0.0;
    let magnitude = value.abs();
    let mut integer = magnitude.floor();
    let mut fraction = magnitude - integer;
    let next = f64::from_bits(magnitude.to_bits() + 1);
    let mut delta = 0.5 * (next - magnitude);
    if delta <= 0.0 {
        delta = f64::from_bits(1);
    }

    if fraction >= delta {
        buffer[fraction_cursor] = b'.';
        fraction_cursor += 1;
        loop {
            fraction *= f64::from(radix);
            delta *= f64::from(radix);
            let mut digit = fraction as usize;
            buffer[fraction_cursor] = DIGITS[digit];
            fraction_cursor += 1;
            fraction -= digit as f64;

            if (fraction > 0.5 || (fraction == 0.5 && digit & 1 != 0)) && fraction + delta > 1.0 {
                loop {
                    fraction_cursor -= 1;
                    if fraction_cursor == midpoint {
                        debug_assert_eq!(buffer[fraction_cursor], b'.');
                        integer += 1.0;
                        break;
                    }
                    digit = match buffer[fraction_cursor] {
                        byte @ b'0'..=b'9' => usize::from(byte - b'0'),
                        byte => usize::from(byte - b'a' + 10),
                    };
                    if digit + 1 < radix as usize {
                        buffer[fraction_cursor] = DIGITS[digit + 1];
                        fraction_cursor += 1;
                        break;
                    }
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }

    let radix_float = f64::from(radix);
    // V8's base::Double::Exponent() is relative to its 53-bit significand.
    while integer / radix_float >= 9_007_199_254_740_992.0 {
        integer /= radix_float;
        integer_cursor -= 1;
        buffer[integer_cursor] = b'0';
    }
    loop {
        let remainder = integer % radix_float;
        integer_cursor -= 1;
        buffer[integer_cursor] = DIGITS[remainder as usize];
        integer = (integer - remainder) / radix_float;
        if integer <= 0.0 {
            break;
        }
    }
    if negative {
        integer_cursor -= 1;
        buffer[integer_cursor] = b'-';
    }
    Rc::from(
        std::str::from_utf8(&buffer[integer_cursor..fraction_cursor])
            .expect("scriptc: radix formatter emitted non-ASCII digits"),
    )
}
