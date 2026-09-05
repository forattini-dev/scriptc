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
        if as_module.is_err() && as_script.is_err() {
            failures += 1;
            let error = as_module.err().map(|e| e.to_string()).unwrap_or_default();
            println!("{path}: {error}");
        }
    }
    println!("{failures} of {total} files refused");
}
