/// Why an embedded module could not be made available.
///
/// `Coded` is a scriptc-level refusal carrying a Node error code (the key
/// is not in the build's table, or the module never finished evaluating);
/// `Engine` is the module's own thrown value. Static `island_import`
/// raises either as a throw at the import site; dynamic
/// `island_import_dyn` turns either into a rejection, which is where Node
/// puts a dynamic import's failure.
enum IslandImportFailure {
    Coded(String, &'static str),
    Engine(BoaJsError),
}

/// Evaluate one embedded module (once per realm) and answer its namespace.
///
/// Both import paths share this: the static form reads one export off the
/// namespace, the dynamic form hands the whole object across.
fn island_module_namespace(
    state: &mut IslandState,
    key: &str,
    binding: Option<(&str, &str)>,
) -> Result<JsValue, IslandImportFailure> {
    if !state.loader.has_embedded(key) {
        // A `node:` specifier is never in the embedded table — the build
        // embeds npm sources, not builtins — so it takes the same
        // synthesized wrapper the ES loader hands the static graph.
        if key.starts_with("node:") {
            return island_builtin_namespace(state, key, binding);
        }
        return Err(IslandImportFailure::Coded(
            format!("Cannot find embedded module '{key}'"),
            "ERR_MODULE_NOT_FOUND",
        ));
    }
    let loader = state.loader.clone();
    let module = loader
        .load(key, &mut state.context)
        .map_err(IslandImportFailure::Engine)?;
    if !with_tables(|t| t.evaluated.contains(key)) {
        island_module_evaluate(state, &module, key, binding)?;
        // Cache only a successful lifecycle. Marking before evaluation
        // made a rejected first import expose an unevaluated namespace on
        // the second import instead of rejecting with the module failure.
        with_tables(|t| t.evaluated.insert(key.to_owned()));
    } else {
        island_check_import_binding(state, &module, binding)?;
    }
    Ok(module.namespace(&mut state.context).into())
}

/// A `node:` builtin reached through `import()`.
///
/// The wrapper is the loader's own (`island_builtin_wrapper`): it only
/// calls `__scr_require`, so it links against nothing and can be parsed
/// and evaluated standalone. Cached per realm, so repeated imports of the
/// same builtin answer the same namespace, like Node's module cache.
fn island_builtin_namespace(
    state: &mut IslandState,
    key: &str,
    binding: Option<(&str, &str)>,
) -> Result<JsValue, IslandImportFailure> {
    if let Some(module) = with_tables(|t| t.builtins.get(key).cloned()) {
        island_check_import_binding(state, &module, binding)?;
        return Ok(module.namespace(&mut state.context).into());
    }
    let source = island_builtin_wrapper(key);
    let mut bytes = source.as_bytes();
    let module = Module::parse(
        Source::from_reader(&mut bytes, Some(Path::new(key))),
        None,
        &mut state.context,
    )
    .map_err(IslandImportFailure::Engine)?;
    island_module_evaluate(state, &module, key, binding)?;
    with_tables(|t| t.builtins.insert(key.to_owned(), module.clone()));
    Ok(module.namespace(&mut state.context).into())
}

/// Load, link and evaluate one module, draining the jobs its evaluation
/// queues so a rejection is visible now rather than at the next turn.
fn island_module_evaluate(
    state: &mut IslandState,
    module: &Module,
    key: &str,
    binding: Option<(&str, &str)>,
) -> Result<(), IslandImportFailure> {
    // SCRIPTC_ISLAND_TRACE: name the module whose graph links and
    // evaluates — an engine panic during compilation (boa's bytecompiler
    // aborts the process) is otherwise unlocatable.
    if std::env::var_os("SCRIPTC_ISLAND_TRACE").is_some() {
        eprintln!("scriptc island: evaluate {key}");
    }
    let loaded = module.load(&mut state.context);
    island_wait_import_promise(state, loaded, key)?;
    module.link(&mut state.context).map_err(IslandImportFailure::Engine)?;
    island_check_import_binding(state, module, binding)?;
    let evaluated = module.evaluate(&mut state.context).map_err(IslandImportFailure::Engine)?;
    island_wait_import_promise(state, evaluated, key)
}

fn island_check_import_binding(
    state: &mut IslandState,
    module: &Module,
    binding: Option<(&str, &str)>,
) -> Result<(), IslandImportFailure> {
    let Some((export, specifier)) = binding else { return Ok(()); };
    let namespace = module.namespace(&mut state.context);
    let present = namespace.has_property(island_string(export), &mut state.context)
        .map_err(IslandImportFailure::Engine)?;
    if present { return Ok(()); }
    Err(IslandImportFailure::Engine(boa_engine::JsNativeError::syntax()
        .with_message(format!("The requested module '{specifier}' does not provide an export named '{export}'")).into()))
}

fn island_wait_import_promise(
    state: &mut IslandState,
    promise: BoaJsPromise,
    key: &str,
) -> Result<(), IslandImportFailure> {
    state
        .context
        .run_jobs()
        .map_err(IslandImportFailure::Engine)?;
    match promise.state() {
        BoaPromiseState::Fulfilled(_) => Ok(()),
        BoaPromiseState::Rejected(reason) => {
            Err(IslandImportFailure::Engine(BoaJsError::from_opaque(reason)))
        }
        BoaPromiseState::Pending => Err(IslandImportFailure::Coded(
            format!("Embedded module '{key}' did not finish evaluating"),
            "ERR_MODULE_EVALUATION_PENDING",
        )),
    }
}

/// Raise an import failure as a static scriptc throw.
fn island_import_throw(failure: IslandImportFailure, context: &mut Context) -> ! {
    match failure {
        IslandImportFailure::Coded(message, code) => throw_error_code(message, code),
        IslandImportFailure::Engine(error) => island_eval_error(error, context),
    }
}

/// The rejection reason the same failure carries into the realm.
fn island_import_reason(failure: IslandImportFailure, context: &mut Context) -> BoaJsError {
    match failure {
        IslandImportFailure::Coded(message, code) => {
            let error = boa_engine::JsNativeError::error()
                .with_message(message)
                .into_opaque(context);
            // Node's module errors are recognised by `.code`, so the
            // rejection reason carries it like the static throw does.
            let _ = error.set(
                js_string!("code"),
                boa_engine::JsString::from(code),
                false,
                context,
            );
            BoaJsError::from_opaque(error.into())
        }
        IslandImportFailure::Engine(error) => error,
    }
}

pub fn island_import(key: &JsString, export: &JsString) -> IslandValue {
    island_import_named(key, export, key)
}

pub fn island_import_named(key: &JsString, export: &JsString, specifier: &JsString) -> IslandValue {
    with_island_state(|state| {
        let binding: Option<(&str, &str)> = if export == "*" { None } else { Some((export, specifier)) };
        let namespace = island_module_namespace(state, key, binding)
            .unwrap_or_else(|failure| island_import_throw(failure, &mut state.context));
        // `import * as ns` binds the module namespace object itself (the
        // C island's scr_jsval_import answers "*" the same way).
        if export == "*" {
            return IslandValue(namespace);
        }
        let value = namespace
            .to_object(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context))
            .get(
                island_string(export),
                &mut state.context,
            )
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value)
    })
}
