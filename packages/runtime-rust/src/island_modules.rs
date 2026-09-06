// The boa island's module loader over the tables in island_tables.rs.

/// Resolves imports against the embedded edge table instead of the
/// filesystem, and synthesizes the `node:*` wrappers on demand.
///
/// Every embedded module is registered here by key at realm boot and
/// PARSED ON FIRST LOAD — a whole CLI embeds thousands of modules, and a
/// command reaches a fraction of them; parsing all of them up front cost
/// redcode 17 s of every start. The loader itself never reaches back
/// into `ISLAND_STATE` (the engine holds the context borrow while it
/// calls).
#[derive(Default)]
pub(crate) struct IslandModuleLoader {
    modules: RefCell<HashMap<String, Module>>,
    pending: RefCell<HashMap<String, &'static IslandModule>>,
    external: RefCell<HashSet<String>>,
}

impl IslandModuleLoader {
    pub(crate) fn insert(&self, key: &str, module: Module) {
        self.modules.borrow_mut().insert(key.to_owned(), module);
    }

    /// Register an embedded module for on-demand parsing.
    pub(crate) fn insert_pending(&self, module: &'static IslandModule) {
        self.pending.borrow_mut().insert(module.key.to_owned(), module);
    }

    /// Whether `key` names an embedded module (parsed or not yet).
    pub(crate) fn has_embedded(&self, key: &str) -> bool {
        self.modules.borrow().contains_key(key) || self.pending.borrow().contains_key(key)
    }

    /// Parse one embedded module into its ES form. A JSON module keeps its
    /// native parse for the ES graph; CJS files enter through their
    /// build-time facade over __scr_require. A parse failure names the
    /// module: the message alone ("expected ';'") says nothing about which
    /// of thousands of sources the engine choked on.
    fn parse_embedded(&self, embedded: &'static IslandModule, context: &mut Context) -> JsResult<Module> {
        let parsed = if embedded.format == IslandModuleFormat::Json {
            Module::parse_json(
                boa_engine::JsString::from(island_module_source(embedded)),
                context,
            )
        } else {
            let source = island_module_esm_source(embedded);
            let mut bytes = source.as_bytes();
            Module::parse(
                Source::from_reader(&mut bytes, Some(Path::new(embedded.key))),
                None,
                context,
            )
        };
        let module = parsed.map_err(|error| {
            let message = match error.try_native(context) {
                Ok(native) => native.message().to_string(),
                Err(_) => error.to_string(),
            };
            let head: String = island_module_source(embedded).chars().take(80).collect();
            boa_engine::JsNativeError::syntax().with_message(format!(
                "the island could not parse embedded module {}: {} (source begins: {:?})",
                embedded.key, message, head
            ))
        })?;
        self.insert(embedded.key, module.clone());
        Ok(module)
    }

    pub(crate) fn load_external(
        &self,
        path: &Path,
        context: &mut Context,
    ) -> JsResult<Module> {
        let key = path.to_string_lossy();
        if let Some(module) = self.modules.borrow().get(key.as_ref()) {
            return Ok(module.clone());
        }
        self.external.borrow_mut().insert(key.to_string());
        let source = Source::from_filepath(path).map_err(|error| {
            boa_engine::JsNativeError::typ()
                .with_message(format!("could not open file `{}`", path.display()))
                .with_cause(BoaJsError::from_rust(error))
        })?;
        let module = Module::parse(source, None, context)?;
        self.insert(key.as_ref(), module.clone());
        Ok(module)
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
        if let Some(key) = island_edge_find(from, specifier, IslandEdgeKind::Import) {
            return Ok(key.to_owned());
        }
        if self.external.borrow().contains(from) &&
            (specifier.starts_with("./") || specifier.starts_with("../"))
        {
            let Some(parent) = Path::new(from).parent() else {
                return Err(boa_engine::JsNativeError::reference()
                    .with_message(format!("cannot resolve module '{specifier}' from '{from}'"))
                    .into());
            };
            let key = parent.join(specifier).to_string_lossy().into_owned();
            self.external.borrow_mut().insert(key.clone());
            return Ok(key);
        }
        Err(boa_engine::JsNativeError::reference()
            .with_message(format!(
                "cannot resolve module '{specifier}' from '{from}' \
                 (scriptc embeds npm code at build time)"
            ))
            .into())
    }

    pub(crate) fn load(&self, key: &str, context: &mut Context) -> JsResult<Module> {
        if let Some(module) = self.modules.borrow().get(key) {
            return Ok(module.clone());
        }
        let pending = self.pending.borrow_mut().remove(key);
        if let Some(embedded) = pending {
            return self.parse_embedded(embedded, context);
        }
        if self.external.borrow().contains(key) {
            return self.load_external(Path::new(key), context);
        }
        if !key.starts_with("node:") {
            return Err(boa_engine::JsNativeError::reference()
                .with_message(format!("module '{key}' is not embedded"))
                .into());
        }
        // A builtin entering the ES graph takes the synthetic wrapper the
        // C island synthesizes (isl_module_load), destructuring the named
        // exports of every builtin the bootstrap shims. One the bootstrap
        // does not register takes the default-only wrapper, and its
        // __scr_require call raises the does-not-provide throw at
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
        // boa drives module linking, so this runs with the engine's
        // frames beneath it — and `load` parses, which reaches the
        // inflate path and the module tables, all of which signal by
        // unwinding.
        let result = island_boundary(&mut context.borrow_mut(), |context| {
            let key = self.resolve(&referrer, &request.specifier().to_std_string_lossy())?;
            self.load(&key, context)
        });
        async { result }
    }

    fn init_import_meta(
        self: Rc<Self>,
        import_meta: &boa_engine::object::JsObject,
        module: &Module,
        context: &mut Context,
    ) {
        // This hook returns nothing, so there is nowhere to raise an
        // error TO. The body's own early returns already say that a
        // module without a usable file path simply gets no
        // `import.meta.url`; a failed define is the same answer. What
        // must not happen is an unwind, which is why the body is a
        // boundary — a genuine panic is parked and re-raised by
        // `with_island_state`.
        let _ = island_boundary(context, |context| {
            let Some(path) = module.path() else {
                return Ok(());
            };
            let Ok(url) = url::Url::from_file_path(path) else {
                return Ok(());
            };
            import_meta.create_data_property_or_throw(
                js_string!("url"),
                boa_engine::JsString::from(url.as_str()),
                context,
            )?;
            Ok(())
        });
    }
}

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
            JsValue::from(boa_engine::JsString::from(island_module_source(module))),
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

/// Run the shared bootstrap: `globalThis.__scr_require` over the embedded
/// tables, the Node builtin shims behind it, and the globals they install
/// (`process`, `Buffer`, the formatting `console`).
///
/// Called once per realm, before any embedded or external module is parsed:
/// CJS facades and external builtin imports call into `__scr_require`.
pub(crate) fn island_modules_boot(context: &mut Context) -> JsResult<()> {
    let host = island_host_object(context);
    let boot = context.eval(Source::from_bytes(ISLAND_MODULE_BOOTSTRAP))?;
    let Some(boot) = boot.as_callable() else {
        return Err(boa_engine::JsNativeError::typ()
            .with_message("scriptc: island module bootstrap is not callable")
            .into());
    };
    boot.call(&JsValue::undefined(), &[host.into()], context)?;
    Ok(())
}


pub fn island_register_modules(modules: &'static [IslandModule]) {
    island_tables_register_modules(modules);
}

pub fn island_register_edges(edges: &'static [IslandEdge]) {
    island_tables_register_edges(edges);
}
