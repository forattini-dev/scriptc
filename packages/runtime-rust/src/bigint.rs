//! Immutable arbitrary-precision integer values for the native compiler ABI.
//! Clones share limbs. Arithmetic creates a new value, so BigInts cannot form
//! cycles and need no traced heap edges. No number conversion is implicit.
use std::{cmp::Ordering, rc::Rc};
use num_bigint::BigInt;
use num_traits::{FromPrimitive, Signed, ToPrimitive, Zero};
use crate::{JsString, throw_range_error, throw_syntax_error, throw_type_error};

// Match V8's maximum bit length. Check huge shifts/exponents before allocating,
// while preserving constant results such as 0 << huge and (-1) ** huge.
const MAX_BITS: u64 = 1 << 30;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JsBigInt(Rc<BigInt>);

impl JsBigInt {
    fn new(value: BigInt) -> Self {
        if value.bits() > MAX_BITS { too_large(); }
        Self(Rc::new(value))
    }
}

fn is_bun() -> bool { crate::target_runtime_id() == "bun" }
fn range_error(node: &str, bun: &str) -> ! { throw_range_error(if is_bun() { bun } else { node }.to_owned()) }
fn too_large() -> ! { range_error("Maximum BigInt size exceeded", "Out of memory: BigInt generated from this operation is too big") }

/// StringToBigInt: whitespace is ECMAScript whitespace, separators and signed
/// nondecimal prefixes are invalid, and an empty trimmed string means zero.
pub fn bigint_parse(value: &JsString) -> Option<JsBigInt> {
    let trimmed = crate::string_trim(value);
    let text: &str = trimmed.as_ref();
    if text.is_empty() { return Some(bigint_from_bool(false)); }
    let (radix, digits) = if text.starts_with("0x") || text.starts_with("0X") { (16, &text[2..]) }
        else if text.starts_with("0o") || text.starts_with("0O") { (8, &text[2..]) }
        else if text.starts_with("0b") || text.starts_with("0B") { (2, &text[2..]) }
        else { (10, text) };
    let unsigned = if radix == 10 { digits.strip_prefix(['+', '-']).unwrap_or(digits) } else { digits };
    // Bun 1.4.1 treats a sign with no digits as zero; Node rejects it.
    if is_bun() && (text == "+" || text == "-") { return Some(bigint_from_bool(false)); }
    if unsigned.is_empty() || !unsigned.bytes().all(|b| b.is_ascii() && (b as char).is_digit(radix)) {
        return None;
    }
    BigInt::parse_bytes(digits.as_bytes(), radix).map(JsBigInt::new)
}

pub fn bigint_from_string(value: &JsString) -> JsBigInt {
    bigint_parse(value).unwrap_or_else(|| throw_syntax_error(if is_bun() { "Failed to parse String to BigInt".to_owned() } else { format!("Cannot convert {value} to a BigInt") }))
}

pub fn bigint_from_number(value: f64) -> JsBigInt {
    if !value.is_finite() || value.fract() != 0.0 {
        throw_range_error(if is_bun() { "Not an integer".to_owned() } else { format!("The number {} cannot be converted to a BigInt because it is not an integer", crate::format_number(value)) });
    }
    JsBigInt::new(BigInt::from_f64(value).expect("finite integral binary64"))
}

pub fn bigint_from_bool(value: bool) -> JsBigInt { JsBigInt::new(BigInt::from(u8::from(value))) }
pub fn bigint_to_number(value: &JsBigInt) -> f64 {
    value.0.to_f64().unwrap_or(if value.0.is_negative() { f64::NEG_INFINITY } else { f64::INFINITY })
}
pub fn bigint_truthy(value: &JsBigInt) -> bool { !value.0.is_zero() }
pub fn bigint_to_string(value: &JsBigInt) -> JsString { JsString::from(value.0.to_string()) }
pub fn bigint_to_string_radix(value: &JsBigInt, radix: f64) -> JsString {
    let radix = radix.trunc();
    if !(2.0..=36.0).contains(&radix) {
        throw_range_error("toString() radix argument must be between 2 and 36".to_owned());
    }
    JsString::from(value.0.to_str_radix(radix as u32))
}
pub fn display_bigint(value: &JsBigInt) -> String { format!("{}n", value.0) }

pub fn bigint_add(a: &JsBigInt, b: &JsBigInt) -> JsBigInt { JsBigInt::new(a.0.as_ref() + b.0.as_ref()) }
pub fn bigint_sub(a: &JsBigInt, b: &JsBigInt) -> JsBigInt { JsBigInt::new(a.0.as_ref() - b.0.as_ref()) }
pub fn bigint_mul(a: &JsBigInt, b: &JsBigInt) -> JsBigInt {
    if !a.0.is_zero() && !b.0.is_zero() && a.0.bits().saturating_add(b.0.bits()) > MAX_BITS + 1 { too_large(); }
    JsBigInt::new(a.0.as_ref() * b.0.as_ref())
}
pub fn bigint_div(a: &JsBigInt, b: &JsBigInt) -> JsBigInt {
    if b.0.is_zero() { range_error("Division by zero", "0 is an invalid divisor value."); }
    JsBigInt::new(a.0.as_ref() / b.0.as_ref())
}
pub fn bigint_rem(a: &JsBigInt, b: &JsBigInt) -> JsBigInt {
    if b.0.is_zero() { range_error("Division by zero", "0 is an invalid divisor value."); }
    JsBigInt::new(a.0.as_ref() % b.0.as_ref())
}
pub fn bigint_neg(a: &JsBigInt) -> JsBigInt { JsBigInt::new(-a.0.as_ref()) }
pub fn bigint_not(a: &JsBigInt) -> JsBigInt { JsBigInt::new(!a.0.as_ref()) }
pub fn bigint_and(a: &JsBigInt, b: &JsBigInt) -> JsBigInt { JsBigInt::new(a.0.as_ref() & b.0.as_ref()) }
pub fn bigint_or(a: &JsBigInt, b: &JsBigInt) -> JsBigInt { JsBigInt::new(a.0.as_ref() | b.0.as_ref()) }
pub fn bigint_xor(a: &JsBigInt, b: &JsBigInt) -> JsBigInt { JsBigInt::new(a.0.as_ref() ^ b.0.as_ref()) }

pub fn bigint_pow(a: &JsBigInt, exponent: &JsBigInt) -> JsBigInt {
    if exponent.0.is_negative() {
        // The pinned Node 24 release's template says "undefined"; Node 26
        // fixes the placeholder. Keep the target's observable error text.
        let node = if crate::target_runtime_id() == "node24" { "undefined must be positive" } else { "Exponent must be positive" };
        range_error(node, "Negative exponent is not allowed");
    }
    if exponent.0.is_zero() { return bigint_from_bool(true); }
    if a.0.is_zero() { return a.clone(); }
    if a.0.bits() == 1 {
        return if a.0.is_negative() && exponent.0.bit(0) { a.clone() } else { bigint_from_bool(true) };
    }
    let power = exponent.0.to_u32().unwrap_or_else(|| too_large());
    if (a.0.bits() - 1).saturating_mul(u64::from(power)) >= MAX_BITS { too_large(); }
    JsBigInt::new(a.0.pow(power))
}

fn shift(a: &JsBigInt, amount: &JsBigInt, left: bool) -> JsBigInt {
    let left = left != amount.0.is_negative();
    if a.0.is_zero() { return a.clone(); }
    let magnitude = amount.0.magnitude().to_u64();
    if !left && magnitude.is_none_or(|n| n >= a.0.bits()) {
        return bigint_from_number(if a.0.is_negative() { -1.0 } else { 0.0 });
    }
    let magnitude = magnitude.unwrap_or_else(|| too_large());
    if left && a.0.bits().saturating_add(magnitude) > MAX_BITS { too_large(); }
    let amount = usize::try_from(magnitude).unwrap_or_else(|_| too_large());
    JsBigInt::new(if left { a.0.as_ref() << amount } else { a.0.as_ref() >> amount })
}
pub fn bigint_shl(a: &JsBigInt, amount: &JsBigInt) -> JsBigInt { shift(a, amount, true) }
pub fn bigint_shr(a: &JsBigInt, amount: &JsBigInt) -> JsBigInt { shift(a, amount, false) }

/// Mixed numeric comparisons use the exact integral binary64 value and then
/// its fraction; rounding the BigInt to f64 would confuse adjacent integers.
pub fn bigint_cmp_number(a: &JsBigInt, b: f64) -> Option<Ordering> {
    if b.is_nan() { return None; }
    if b == f64::INFINITY { return Some(Ordering::Less); }
    if b == f64::NEG_INFINITY { return Some(Ordering::Greater); }
    let integer = BigInt::from_f64(b).expect("finite binary64");
    let order = a.0.as_ref().cmp(&integer);
    Some(if order != Ordering::Equal || b.fract() == 0.0 { order }
        else if b.fract() > 0.0 { Ordering::Less } else { Ordering::Greater })
}

fn bit_width(bits: f64) -> u64 {
    let integer = if bits.is_nan() { 0.0 } else { bits.trunc() };
    if !(0.0..=9_007_199_254_740_991.0).contains(&integer) {
        range_error("Invalid value: not (convertible to) a safe integer", if integer < 0.0 { "number of bits cannot be negative" } else { "number of bits larger than (2 ** 53) - 1" });
    }
    integer as u64
}

pub fn bigint_as_uint_n(bits: f64, value: &JsBigInt) -> JsBigInt {
    let width = bit_width(bits);
    if width == 0 { return bigint_from_bool(false); }
    if !value.0.is_negative() && value.0.bits() <= width { return value.clone(); }
    if width > MAX_BITS { too_large(); }
    let mask = (BigInt::from(1_u8) << width as usize) - 1_u8;
    JsBigInt::new(value.0.as_ref() & mask)
}

pub fn bigint_as_int_n(bits: f64, value: &JsBigInt) -> JsBigInt {
    let width = bit_width(bits);
    if width == 0 { return bigint_from_bool(false); }
    let sign_bits = if value.0.is_negative() { (!value.0.as_ref()).bits() } else { value.0.bits() };
    if sign_bits < width { return value.clone(); }
    let unsigned = bigint_as_uint_n(bits, value);
    if unsigned.0.bit(width - 1) {
        JsBigInt::new(unsigned.0.as_ref() - (BigInt::from(1_u8) << (width as usize)))
    } else { unsigned }
}

impl crate::Trace for JsBigInt { fn trace(&self, _: &mut crate::Tracer<'_>) {} }
impl crate::HeapValue for JsBigInt { fn trace_value(&self, _: &mut crate::Tracer<'_>) {} }
impl crate::ArrayElement for JsBigInt {}
impl crate::JoinElement for JsBigInt {
    fn append_joined(&self, output: &mut crate::JsStringBuilder) { output.push_str(&self.0.to_string()); }
}
impl crate::JsonValue for JsBigInt {
    fn write_json(&self, _: &mut crate::JsonWriter) {
        throw_type_error(if is_bun() { "JSON.stringify cannot serialize BigInt." } else { "Do not know how to serialize a BigInt" }.to_owned());
    }
}

#[cfg(test)]
#[path = "bigint.test.rs"]
mod tests;
