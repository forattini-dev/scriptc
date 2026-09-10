thread_local! {
    static MATH_RANDOM_STATE: Cell<u64> = const { Cell::new(0x9e37_79b9_7f4a_7c15) };
}

pub fn math_random() -> f64 {
    MATH_RANDOM_STATE.with(|state| {
        let mut next = state.get();
        next ^= next >> 12;
        next ^= next << 25;
        next ^= next >> 27;
        state.set(next);
        let bits = next.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11;
        bits as f64 * (1.0 / 9_007_199_254_740_992.0)
    })
}

// Console/process stream writes never fail the program: Node swallows
// EPIPE on process.stdout/stderr (`program | head` finishes cleanly) and
// the C runtime ignores fwrite results the same way — a dead pipe must
// not become an abort, and process.stdout.write never throws.
pub fn console_log(values: &[String]) {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = lock.write_all(values.join(" ").as_bytes());
    let _ = lock.write_all(b"\n");
}

pub fn console_error(values: &[String]) {
    use std::io::Write;
    let stderr = std::io::stderr();
    let mut lock = stderr.lock();
    let _ = lock.write_all(values.join(" ").as_bytes());
    let _ = lock.write_all(b"\n");
}

pub fn process_stdout_write(value: &JsString) -> bool {
    use std::io::Write;
    let _ = std::io::stdout().lock().write_all(value.as_bytes());
    true
}

pub fn process_stderr_write(value: &JsString) -> bool {
    use std::io::Write;
    let _ = std::io::stderr().lock().write_all(value.as_bytes());
    true
}

pub fn to_int32(value: f64) -> i32 {
    // Truncate the binary64 significand and retain its low 32 integer bits.
    // This is ToInt32's modulo without floating-point division. Exponents
    // below zero truncate to zero; at 84 and above every representable finite
    // double is a multiple of 2^32. The same guard handles NaN and infinities.
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32 - 1023;
    if !(0..84).contains(&exponent) { return 0; }
    let significand = (bits & 0x000f_ffff_ffff_ffff) | 0x0010_0000_0000_0000;
    let magnitude = if exponent >= 52 {
        (significand << (exponent - 52)) as u32
    } else {
        (significand >> (52 - exponent)) as u32
    };
    // Negate AFTER truncation; unsigned wrapping preserves the modulo for
    // negative values, including those outside the signed integer range.
    (if bits >> 63 != 0 { magnitude.wrapping_neg() } else { magnitude }) as i32
}

pub fn to_uint32(value: f64) -> u32 {
    to_int32(value) as u32
}

pub fn bit_not(value: f64) -> f64 {
    (!to_int32(value)) as f64
}

pub fn bit_and(left: f64, right: f64) -> f64 {
    (to_int32(left) & to_int32(right)) as f64
}

pub fn bit_or(left: f64, right: f64) -> f64 {
    (to_int32(left) | to_int32(right)) as f64
}

pub fn bit_xor(left: f64, right: f64) -> f64 {
    (to_int32(left) ^ to_int32(right)) as f64
}

pub fn shift_left(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shl(to_uint32(right) & 31) as f64
}

pub fn shift_right(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shr(to_uint32(right) & 31) as f64
}

pub fn shift_right_unsigned(left: f64, right: f64) -> f64 {
    to_uint32(left).wrapping_shr(to_uint32(right) & 31) as f64
}
