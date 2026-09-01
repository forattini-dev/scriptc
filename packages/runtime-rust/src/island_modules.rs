/* The embedded npm module graph the island realm resolves against.
 *
 * `--dynamic` builds embed every reached module's SOURCE as a static
 * string plus the (importer, specifier) → target edges the compiler's
 * resolver walked at build time; binaries never read node_modules at
 * runtime. This file owns the tables and the two lookups over them —
 * the module loader and the CommonJS require shim in `island_eval.rs`
 * are their only readers.
 */

/// How a module's stored `source` must be evaluated.
///
/// `Cjs` modules additionally carry `esm`: the facade synthesized at
/// BUILD time (default plus the named exports lexed from the source),
/// which is what the ES module graph evaluates when it imports the file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IslandModuleFormat {
    Esm,
    Cjs,
    Json,
}

#[derive(Clone, Copy)]
pub struct IslandModule {
    pub key: &'static str,
    pub source: &'static str,
    pub format: IslandModuleFormat,
    pub esm: Option<&'static str>,
}

/// Which call form an edge was resolved for.
///
/// One `(from, specifier)` pair can carry two edges when a dual package's
/// "exports" map names different files under the "import" and "require"
/// conditions; `Any` (relative files, builtins) serves both lookups.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IslandEdgeKind {
    Any,
    Import,
    Require,
}

#[derive(Clone, Copy)]
pub struct IslandEdge {
    pub from: &'static str,
    pub specifier: &'static str,
    pub to: &'static str,
    pub kind: IslandEdgeKind,
}

thread_local! {
    static ISLAND_MODULES: RefCell<&'static [IslandModule]> = const { RefCell::new(&[]) };
    static ISLAND_EDGES: RefCell<&'static [IslandEdge]> = const { RefCell::new(&[]) };
}

/// Install the embedded module table. Emitted `main` calls this before
/// any generated code can reach the island.
pub fn island_register_modules(modules: &'static [IslandModule]) {
    ISLAND_MODULES.with(|slot| *slot.borrow_mut() = modules);
}

/// Install the resolution edge table, alongside the module table.
pub fn island_register_edges(edges: &'static [IslandEdge]) {
    ISLAND_EDGES.with(|slot| *slot.borrow_mut() = edges);
}

pub(crate) fn island_registered_modules() -> &'static [IslandModule] {
    ISLAND_MODULES.with(|slot| *slot.borrow())
}

pub(crate) fn island_module_find(key: &str) -> Option<&'static IslandModule> {
    island_registered_modules()
        .iter()
        .find(|module| module.key == key)
}

/// Resolve `(from, specifier)` for one call form, mirroring the island's
/// C loader.
///
/// `want` is the LOOKUP's kind — the ES module loader asks with `Import`,
/// the require shim with `Require`. An import lookup missing its own kind
/// falls back to a require edge (a build-time-invisible `import()` of a
/// specifier the file only `require`s loads the CJS entry through its
/// facade, which is the module Node's require condition serves), but a
/// require lookup NEVER falls back: import-kind edges can target real ES
/// modules, and MODULE_NOT_FOUND is the honest answer for a require the
/// build never resolved.
pub(crate) fn island_edge_find(
    from: &str,
    specifier: &str,
    want: IslandEdgeKind,
) -> Option<&'static str> {
    let mut fallback = None;
    for edge in ISLAND_EDGES.with(|slot| *slot.borrow()) {
        if edge.from != from || edge.specifier != specifier {
            continue;
        }
        if edge.kind == IslandEdgeKind::Any || edge.kind == want {
            return Some(edge.to);
        }
        if want == IslandEdgeKind::Import && edge.kind == IslandEdgeKind::Require {
            fallback = Some(edge.to);
        }
    }
    fallback
}

/// Drop both tables. Island teardown runs this so a re-entered realm
/// cannot observe a previous program's graph.
pub(crate) fn island_modules_reset() {
    ISLAND_MODULES.with(|slot| *slot.borrow_mut() = &[]);
    ISLAND_EDGES.with(|slot| *slot.borrow_mut() = &[]);
}

/* ── the ES module loader ──────────────────────────────────────────── */

const ISLAND_MODULE_BOOTSTRAP: &str = include_str!("island_modules.js");

/// Resolves imports against the embedded edge table instead of the
/// filesystem, and synthesizes the `node:*` wrappers on demand.
///
/// Every embedded module is parsed into its ES form at realm boot and
/// inserted here by key; the loader itself never reaches back into
/// `ISLAND_STATE` (the engine holds the context borrow while it calls).
#[derive(Default)]
pub(crate) struct IslandModuleLoader {
    modules: RefCell<HashMap<String, Module>>,
}

impl IslandModuleLoader {
    pub(crate) fn insert(&self, key: &str, module: Module) {
        self.modules.borrow_mut().insert(key.to_owned(), module);
    }

    /// Map `(referrer, specifier)` onto an embedded key.
    ///
    /// `node:` specifiers are their own keys. A referrer with no path is
    /// the import boundary — generated code passes already-resolved keys
    /// there, exactly like the C loader's `<scr-import>` base.
    fn resolve(&self, referrer: &Referrer, specifier: &str) -> JsResult<String> {
        if specifier.starts_with("node:") {
            return Ok(specifier.to_owned());
        }
        let Some(from) = referrer.path().and_then(Path::to_str) else {
            return Ok(specifier.to_owned());
        };
        island_edge_find(from, specifier, IslandEdgeKind::Import)
            .map(str::to_owned)
            .ok_or_else(|| {
                boa_engine::JsNativeError::reference()
                    .with_message(format!(
                        "cannot resolve module '{specifier}' from '{from}' \
                         (scriptc embeds npm code at build time)"
                    ))
                    .into()
            })
    }

    fn load(&self, key: &str, context: &mut Context) -> JsResult<Module> {
        if let Some(module) = self.modules.borrow().get(key) {
            return Ok(module.clone());
        }
        if !key.starts_with("node:") {
            return Err(boa_engine::JsNativeError::reference()
                .with_message(format!("module '{key}' is not embedded"))
                .into());
        }
        // A builtin entering the ES graph takes the synthetic wrapper the
        // C island synthesizes (isl_module_load): the named-export list
        // arrives with the shims, so for now the wrapper is default-only
        // and its __scr_require call raises the does-not-provide throw at
        // EVALUATION, not at link.
        let source = island_builtin_wrapper(key);
        let mut bytes = source.as_bytes();
        let module = Module::parse(
            Source::from_reader(&mut bytes, Some(Path::new(key))),
            None,
            context,
        )?;
        self.insert(key, module.clone());
        Ok(module)
    }
}

impl boa_engine::module::ModuleLoader for IslandModuleLoader {
    fn load_imported_module(
        self: Rc<Self>,
        referrer: Referrer,
        request: ModuleRequest,
        context: &RefCell<&mut Context>,
    ) -> impl std::future::Future<Output = JsResult<Module>> {
        let result = self
            .resolve(&referrer, &request.specifier().to_std_string_lossy())
            .and_then(|key| self.load(&key, &mut context.borrow_mut()));
        async { result }
    }
}

/// `const m = __scr_require("node:x"); export default m;`
pub(crate) fn island_builtin_wrapper(key: &str) -> String {
    format!(
        "const m=globalThis.__scr_require({});export default m;",
        island_js_quote(key),
    )
}

/// The ES source an embedded module contributes to the module graph.
///
/// CJS files enter through the facade synthesized at BUILD time (default
/// plus the names the compiler's CJS lexer found), which is Node's
/// interop exactly; a facade-less CJS or JSON file takes the
/// default-only wrapper.
pub(crate) fn island_module_esm_source(module: &IslandModule) -> String {
    match module.format {
        IslandModuleFormat::Esm => module.source.to_owned(),
        IslandModuleFormat::Cjs | IslandModuleFormat::Json => module
            .esm
            .map_or_else(|| island_builtin_wrapper(module.key), str::to_owned),
    }
}

/// Quote a module key as a JavaScript string literal.
fn island_js_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\u{2028}' => quoted.push_str("\\u2028"),
            '\u{2029}' => quoted.push_str("\\u2029"),
            character if (character as u32) < 0x20 => {
                quoted.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

/* ── the host bridge the require shim calls ────────────────────────── */

/// `host.source(key)` → `[source, format]`, or `undefined` when the key
/// is not embedded. The format code matches the C island's table
/// (0 = ESM, 1 = CJS, 2 = JSON) and the shim's own branches.
fn island_host_source(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let key = arguments
        .first()
        .cloned()
        .unwrap_or_else(JsValue::undefined)
        .to_string(context)?
        .to_std_string_lossy();
    let Some(module) = island_module_find(&key) else {
        return Ok(JsValue::undefined());
    };
    let format = match module.format {
        IslandModuleFormat::Esm => 0,
        IslandModuleFormat::Cjs => 1,
        IslandModuleFormat::Json => 2,
    };
    let entry = BoaJsArray::from_iter(
        [
            JsValue::from(boa_engine::JsString::from(module.source)),
            JsValue::from(format),
        ],
        context,
    );
    Ok(entry.into())
}

/// `host.resolve(from, specifier)` → the target key, or `undefined`.
///
/// This serves the require shim exclusively, so it looks edges up with
/// the require kind; `node:` specifiers are their own keys.
fn island_host_resolve(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let argument = |index: usize| {
        arguments
            .get(index)
            .cloned()
            .unwrap_or_else(JsValue::undefined)
    };
    let from = argument(0).to_string(context)?.to_std_string_lossy();
    let specifier = argument(1).to_string(context)?.to_std_string_lossy();
    if specifier.starts_with("node:") {
        return Ok(JsValue::from(boa_engine::JsString::from(specifier)));
    }
    Ok(
        match island_edge_find(&from, &specifier, IslandEdgeKind::Require) {
            Some(to) => JsValue::from(boa_engine::JsString::from(to)),
            None => JsValue::undefined(),
        },
    )
}

/// Install `globalThis.__scr_require` over the embedded tables.
///
/// Called once per realm, before any embedded module is parsed: the CJS
/// facades the ES graph evaluates call straight into it.
pub(crate) fn island_modules_boot(context: &mut Context) -> JsResult<()> {
    let host = ObjectInitializer::new(context)
        .function(
            NativeFunction::from_fn_ptr(island_host_source),
            js_string!("source"),
            1,
        )
        .function(
            NativeFunction::from_fn_ptr(island_host_resolve),
            js_string!("resolve"),
            2,
        )
        .build();
    let boot = context.eval(Source::from_bytes(ISLAND_MODULE_BOOTSTRAP))?;
    let Some(boot) = boot.as_callable() else {
        return Err(boa_engine::JsNativeError::typ()
            .with_message("scriptc: island module bootstrap is not callable")
            .into());
    };
    boot.call(&JsValue::undefined(), &[host.into()], context)?;
    Ok(())
}
