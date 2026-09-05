//! Link ES module files under the island engine (boa) against SYNTHETIC
//! stand-ins for everything they import, so the engine's bytecompiler runs
//! over each file in isolation — boa compiles module code at link time,
//! which `island_parse` never reaches. Reports panics and link errors:
//! `cargo run --example island_link --features island-eval -- <files...>`.
use boa_ast::ModuleItem;
use boa_ast::declaration::ImportKind;
use boa_engine::module::{ModuleLoader, ModuleRequest, Referrer, SyntheticModuleInitializer};
use boa_engine::{Context, JsResult, JsString, Module, Source, js_string};
use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::rc::Rc;

/// Every specifier resolves to a synthetic module exporting the names the
/// importer asked for (plus `default`), values undefined.
struct StubLoader {
    wanted: Vec<JsString>,
    cache: RefCell<HashMap<String, Module>>,
}

impl ModuleLoader for StubLoader {
    fn load_imported_module(
        self: Rc<Self>,
        _referrer: Referrer,
        request: ModuleRequest,
        context: &RefCell<&mut Context>,
    ) -> impl Future<Output = JsResult<Module>> {
        let key = request.specifier().to_std_string_lossy();
        let cached = self.cache.borrow().get(&key).cloned();
        let module = cached.unwrap_or_else(|| {
            let mut names = self.wanted.clone();
            if !names.iter().any(|n| n == &js_string!("default")) {
                names.push(js_string!("default"));
            }
            let m = Module::synthetic(
                &names,
                SyntheticModuleInitializer::from_copy_closure(|_module, _context| Ok(())),
                None,
                None,
                &mut context.borrow_mut(),
            );
            self.cache.borrow_mut().insert(key, m.clone());
            m
        });
        std::future::ready(Ok(module))
    }
}

fn imported_names(bytes: &[u8]) -> Result<Vec<JsString>, String> {
    let mut scratch = Context::default();
    let scope = scratch.realm().scope().clone();
    let parsed = boa_parser::Parser::new(Source::from_bytes(bytes))
        .parse_module(&scope, scratch.interner_mut())
        .map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for item in parsed.items().items() {
        if let ModuleItem::ImportDeclaration(decl) = item {
            if let ImportKind::Named { names: list, .. } = decl.kind() {
                for n in list {
                    let text = scratch.interner().resolve_expect(n.export_name()).to_string();
                    names.push(JsString::from(text.as_str()));
                }
            }
        }
    }
    Ok(names)
}

fn main() {
    let mut failures = 0usize;
    let mut total = 0usize;
    for path in std::env::args().skip(1) {
        let Ok(bytes) = std::fs::read(&path) else { continue; };
        let text = String::from_utf8_lossy(&bytes);
        if !(path.ends_with(".mjs") || text.contains("import ") || text.contains("export ")) {
            continue;
        }
        total += 1;
        let names = match imported_names(&bytes) {
            Ok(names) => names,
            Err(error) => { println!("{path}: parse: {error}"); failures += 1; continue; }
        };
        let loader = Rc::new(StubLoader { wanted: names, cache: RefCell::new(HashMap::new()) });
        let mut context = Context::builder().module_loader(loader).build().expect("context");
        let mut limits = context.runtime_limits();
        limits.set_recursion_limit(8_192);
        limits.set_stack_size_limit(4 * 1024 * 1024);
        context.set_runtime_limits(limits);
        let module = match Module::parse(Source::from_reader(&mut &bytes[..], Some(Path::new(&path))), None, &mut context) {
            Ok(m) => m,
            Err(error) => { println!("{path}: parse: {error}"); failures += 1; continue; }
        };
        let promise = module.load_link_evaluate(&mut context);
        let _ = context.run_jobs();
        if let boa_engine::builtins::promise::PromiseState::Rejected(reason) = promise.state() {
            let text = reason.display().to_string();
            if text.contains("SyntaxError") {
                println!("{path}: link: {text}");
                failures += 1;
            }
        }
    }
    println!("{failures} of {total} modules refused");
}
