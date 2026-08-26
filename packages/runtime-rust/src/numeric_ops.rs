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

pub fn console_log(values: &[String]) {
    println!("{}", values.join(" "));
}

pub fn console_error(values: &[String]) {
    eprintln!("{}", values.join(" "));
}

pub fn process_stdout_write(value: &JsString) -> bool {
    use std::io::Write;
    std::io::stdout()
        .lock()
        .write_all(value.as_bytes())
        .expect("scriptc: stdout write failed");
    true
}

pub fn process_stderr_write(value: &JsString) -> bool {
    use std::io::Write;
    std::io::stderr()
        .lock()
        .write_all(value.as_bytes())
        .expect("scriptc: stderr write failed");
    true
}

pub fn to_int32(value: f64) -> i32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    let truncated = value.trunc();
    let modulo = truncated.rem_euclid(4_294_967_296.0);
    if modulo >= 2_147_483_648.0 {
        (modulo - 4_294_967_296.0) as i32
    } else {
        modulo as i32
    }
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
