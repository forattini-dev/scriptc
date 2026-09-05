//! Evaluate an ES module file with the island engine (boa) and its plain
//! file loader — no scriptc runtime, no shims — to tell an engine bug from
//! a runtime-side one: `cargo run --example island_module --features
//! island-eval -- <root-dir> <module-path>`. Prints the module's
//! `probe` export result when it has one.
use boa_engine::{Context, JsValue, Module, Source, js_string};
use boa_engine::module::SimpleModuleLoader;
use std::path::Path;
use std::rc::Rc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = Path::new(&args[0]);
    let loader = Rc::new(SimpleModuleLoader::new(root).expect("root"));
    let mut context = Context::builder().module_loader(loader.clone()).build().expect("context");
    let mut limits = context.runtime_limits();
    limits.set_recursion_limit(8_192);
    limits.set_stack_size_limit(4 * 1024 * 1024);
    context.set_runtime_limits(limits);
    let path = Path::new(&args[1]);
    let source = Source::from_filepath(path).expect("module file");
    let module = Module::parse(source, None, &mut context).unwrap_or_else(|e| panic!("parse: {e}"));
    loader.insert(path.canonicalize().expect("canonical"), module.clone());
    let promise = module.load_link_evaluate(&mut context);
    context.run_jobs().unwrap_or_else(|e| println!("jobs error: {e}"));
    match promise.state() {
        boa_engine::builtins::promise::PromiseState::Fulfilled(_) => {
            let ns = module.namespace(&mut context);
            match ns.get(js_string!("probe"), &mut context) {
                Ok(f) if f.is_callable() => match f.as_callable().unwrap().call(&JsValue::undefined(), &[], &mut context) {
                    Ok(v) => println!("probe: {}", v.to_string(&mut context).map(|s| s.to_std_string_lossy()).unwrap_or_default()),
                    Err(e) => println!("probe error: {e}"),
                },
                _ => println!("evaluated (no probe export)"),
            }
        }
        boa_engine::builtins::promise::PromiseState::Rejected(reason) => {
            println!("evaluation rejected: {}", reason.display());
        }
        boa_engine::builtins::promise::PromiseState::Pending => println!("evaluation pending"),
    }
}
