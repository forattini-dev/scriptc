//! Evaluate JavaScript snippets with the island engine (boa) and print
//! each result or error — a fast probe for engine gaps ahead of a build:
//! `cargo run --example island_eval --features island-eval -- '<js>' ...`.
use boa_engine::{Context, Source};

fn main() {
    let mut context = Context::default();
    for snippet in std::env::args().skip(1) {
        match context.eval(Source::from_bytes(snippet.as_bytes())) {
            Ok(value) => match value.to_string(&mut context) {
                Ok(text) => println!("ok: {}", text.to_std_string_lossy()),
                Err(_) => println!("ok: {}", value.display()),
            },
            Err(error) => println!("error: {error}"),
        }
    }
}
