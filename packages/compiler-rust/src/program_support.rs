// Included in emitted programs. Primitive JS behavior, with no JS evaluator.
fn js_number(value: f64) -> String {
    if value == 0.0 && value.is_sign_negative() {
        "-0".into()
    } else if value == 0.0 {
        "0".into()
    } else {
        ryu_js::Buffer::new().format(value).to_string()
    }
}

fn js_pow(base: f64, exponent: f64) -> f64 {
    // ECMAScript exponentiation differs from powf for ±1 ** ±Infinity.
    if exponent.is_nan() {
        f64::NAN
    } else if exponent == 0.0 {
        1.0
    } else if base.abs() == 1.0 && exponent.is_infinite() {
        f64::NAN
    } else {
        base.powf(exponent)
    }
}

fn console(error: bool, values: &[String]) {
    use std::io::Write;
    let line = values.join(" ") + "\n";
    if error {
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    } else {
        let _ = std::io::stdout().lock().write_all(line.as_bytes());
    }
}
