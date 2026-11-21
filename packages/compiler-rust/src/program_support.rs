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

fn js_string_number(value: f64) -> String {
    if value == 0.0 { "0".into() } else { js_number(value) }
}

fn js_string_concat_number(prefix: &'static str, value: f64) -> runtime::JsString {
    let suffix = js_string_number(value);
    let mut result = String::with_capacity(prefix.len() + suffix.len());
    result.push_str(prefix);
    result.push_str(&suffix);
    runtime::JsString::from(result)
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

// Node applies util.format-style substitutions only when the first argument is
// a string. Values have already crossed the native console inspection boundary;
// this pass owns placeholder consumption and, importantly, handles placeholders
// introduced by template substitutions at runtime.
fn console_format(error: bool, values: &[String]) {
    let Some(template) = values.first() else {
        return console(error, values);
    };
    if values.len() == 1 {
        return console(error, values);
    }
    let mut output = String::new();
    let mut chars = template.chars().peekable();
    let mut argument = 1usize;
    while let Some(ch) = chars.next() {
        if ch != '%' {
            output.push(ch);
            continue;
        }
        let Some(specifier) = chars.peek().copied() else {
            output.push('%');
            break;
        };
        if specifier == '%' {
            chars.next();
            output.push('%');
            continue;
        }
        if !matches!(specifier, 's' | 'd' | 'i' | 'f' | 'j' | 'o' | 'O' | 'c')
            || argument >= values.len()
        {
            output.push('%');
            continue;
        }
        chars.next();
        if specifier != 'c' {
            output.push_str(&values[argument]);
        }
        argument += 1;
    }
    for value in &values[argument..] {
        output.push(' ');
        output.push_str(value);
    }
    console(error, &[output]);
}
