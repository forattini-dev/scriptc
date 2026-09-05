//! Parse JavaScript files with the island engine (boa) and report the ones
//! it refuses — a fast loop for engine-parser gaps ahead of a full build:
//! `cargo run --example island_parse --features island-eval -- <files...>`.
//! Files ending in .mjs, or whose text contains `import `/`export `, parse
//! as modules; everything else as scripts, then as modules on failure.
use boa_engine::{Context, Module, Source};

fn main() {
    let mut context = Context::default();
    let mut failures = 0usize;
    let mut total = 0usize;
    for path in std::env::args().skip(1) {
        let Ok(bytes) = std::fs::read(&path) else {
            println!("{path}: unreadable");
            continue;
        };
        total += 1;
        let text = String::from_utf8_lossy(&bytes);
        let module_like = path.ends_with(".mjs")
            || text.contains("import ")
            || text.contains("export ")
            || text.contains("import(");
        let as_module = Module::parse(Source::from_bytes(&bytes), None, &mut context).map(|_| ());
        let as_script = if module_like {
            Err(())
        } else {
            context.eval(Source::from_bytes(b"void 0")).map(|_| ()).map_err(|_| ())
                .and_then(|_| boa_engine::Script::parse(Source::from_bytes(&bytes), None, &mut context).map(|_| ()).map_err(|_| ()))
        };
        // A script also COMPILES the way the require shim loads it — as a
        // `new Function` body — so bytecompiler panics surface here too.
        if !module_like && as_script.is_ok() {
            let quoted = js_quote(&text);
            let code = format!(
                "new Function(\"exports\", \"require\", \"module\", \"__filename\", \"__dirname\", {quoted}); 0"
            );
            if let Err(error) = context.eval(Source::from_bytes(code.as_bytes())) {
                failures += 1;
                println!("{path}: compile: {error}");
                continue;
            }
        }
        if as_module.is_err() && as_script.is_err() {
            failures += 1;
            let error = as_module.err().map(|e| e.to_string()).unwrap_or_default();
            println!("{path}: {error}");
        }
    }
    println!("{failures} of {total} files refused");
}

/// Quote text as a JavaScript string literal (the JSON subset, plus the
/// two line terminators JSON leaves raw).
fn js_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
