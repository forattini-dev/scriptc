//! Feasibility probe for the V8 island: platform, isolate, context, one
//! evaluation. `cargo run --release --example v8_smoke --features island-v8`.
fn main() {
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();
    let start = std::time::Instant::now();
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let handle_scope, isolate);
    let context = v8::Context::new(handle_scope, Default::default());
    let scope = &v8::ContextScope::new(handle_scope, context);
    let source = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "let n = 0; for (let i = 0; i < 1e7; i++) n += i % 7; n".to_owned());
    let code = v8::String::new(scope, &source).unwrap();
    let script = v8::Script::compile(scope, code, None).unwrap();
    let result = script.run(scope).unwrap();
    let text = result.to_string(scope).unwrap().to_rust_string_lossy(scope);
    println!("ok: {text} ({} ms from isolate creation)", start.elapsed().as_millis());
}
