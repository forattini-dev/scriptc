use crate::ir::{Expr, Function, Module, Stmt, Type, always_returns};
mod async_cfg;
mod async_finally;
mod async_context;
mod async_normalize;
mod bigint;
mod buffer_values;
mod bytes;
mod child_process;
pub(crate) mod chunks;
mod classes;
mod collections;
mod context;
mod filesystem_values;
mod iteration;
use context::Emission;
mod exceptions;
mod functions;
mod generators;
mod json_functions;
mod layouts;
mod network;
mod process;
mod property_delete;
mod protected_exit;
mod protected_linear;
mod receivers;
mod record_construction;
mod record_storage;
mod regex;
mod sets;
mod storage;
mod symbols;
mod values;
mod weak_maps;

fn rust_type(ty: Type, module: &Emission<'_>) -> String {
    match ty {
        Type::Dyn | Type::Caught => "NativeValue",
        Type::Promise { .. } => "runtime::JsPromise<NativeValue>",
        Type::Generator {
            r#async,
            yield_type,
            return_type,
            next_type,
        } => {
            let channel = |ty: Type| {
                if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
                    "()".into()
                } else {
                    rust_type(ty, module)
                }
            };
            return format!(
                "runtime::{}<{}, {}, {}>",
                if r#async {
                    "JsAsyncGenerator"
                } else {
                    "JsGenerator"
                },
                channel(*yield_type),
                channel(*return_type),
                channel(*next_type)
            );
        }
        Type::Child => "runtime::JsChild",
        Type::Stats => "runtime::JsStats",
        Type::Dirent => "runtime::FsDirent",
        ty @ Type::Func { .. } => {
            return format!("runtime::Gc<{}>", functions::type_name(&ty, module));
        }
        Type::F64 => "f64",
        Type::Bigint => "runtime::JsBigInt",
        Type::Bool => "bool",
        Type::Regex => "runtime::JsRegex",
        Type::CryptoHash => "runtime::JsCryptoHash",
        Type::CryptoSign => "runtime::JsCryptoSign",
        Type::Symbol => "runtime::JsSymbol",
        Type::Bytes { elem } => return format!("runtime::JsBytes<{elem}>"),
        Type::Object { .. } => "runtime::Gc<NativeInstance>",
        Type::Classval { .. } => "NativeClass",
        Type::String => "runtime::JsString",
        Type::Void => "()",
        Type::Map { key, value } => {
            if *key == Type::Dyn && *value == Type::Dyn {
                return "runtime::Gc<NativeMap<NativeValue, NativeValue>>".into();
            }
            return format!(
                "NativeTypedMap<{}, {}>",
                rust_type(*key, module),
                rust_type(*value, module)
            );
        }
        Type::Set { elem } => {
            return format!("NativeTypedSet<{}>", rust_type(*elem, module));
        }
        Type::Array { elem } => {
            return format!(
                "runtime::JsArray<{}>",
                if *elem == Type::String {
                    "runtime::JsString".into()
                } else {
                    rust_type(*elem, module)
                }
            );
        }
        Type::Null | Type::Undefined => "()",
        Type::Record { shape_id } => {
            return format!("runtime::Gc<R{shape_id}>");
        }
        Type::Union { union_id } => return format!("U{union_id}"),
    }
    .into()
}

fn field_name(name: &str) -> String {
    format!(
        "f_{}",
        name.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

fn function_name(name: &str) -> String {
    if name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        return name.into();
    }
    format!(
        "encoded_{}",
        name.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

// These statements run before a terminal await and cannot complete the async
// function themselves. In particular, do not admit return/break/continue or
// protected regions without carrying their completion in a continuation.
fn terminal_await_prefix_supported(stmts: &[Stmt]) -> bool {
    stmts.iter().all(|stmt| match stmt {
        Stmt::VarDecl { .. } | Stmt::Assign { .. } | Stmt::Expression { .. } => true,
        Stmt::If { then, else_, .. } => {
            terminal_await_prefix_supported(then)
                && else_
                    .as_ref()
                    .is_none_or(|body| terminal_await_prefix_supported(body))
        }
        Stmt::Block { body, .. } => terminal_await_prefix_supported(body),
        _ => false,
    })
}

/// `process.argv[1]` names the entry module's canonical source path, the
/// same file `import.meta.url` describes, as `node <entry>` would report.
fn entry_script_statement(module: &Module) -> String {
    let Ok(path) = std::fs::canonicalize(&module.source_file) else {
        return String::new();
    };
    let Some(path) = path.to_str() else {
        return String::new();
    };
    #[cfg(windows)]
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|unc| format!(r"\\{unc}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_owned());
    #[cfg(not(windows))]
    let path = path.to_owned();
    format!("runtime::process_set_entry_script({path:?});")
}

/// Whether some continuation planner can schedule every await of `function`.
fn async_plannable(function: &Function) -> bool {
    if function.generator.is_some() {
        return true;
    }
    let mut awaits = 0;
    function.visit_expressions(&mut |expr| awaits += usize::from(matches!(expr, Expr::Await { .. })));
    if awaits == 0 {
        return true;
    }
    if !function.is_async {
        return false;
    }
    let terminal = matches!(
        function.body.last(),
        Some(Stmt::Return {
            value: Some(Expr::Await { .. }),
            ..
        })
    );
    let safe_prefix =
        terminal_await_prefix_supported(&function.body[..function.body.len().saturating_sub(1)]);
    (awaits == 1
        && ((terminal && safe_prefix)
            || simple_await_local(function).is_some()
            || protected_await_return(function).is_some()
            || protected_catch_await(function).is_some()))
        || (awaits == 2 && protected_two_awaits(function).is_some())
        || protected_linear::plan(function).is_some_and(|plan| protected_linear::count(&plan) == awaits)
        || protected_exit::plan(function).is_some_and(|plan| protected_exit::count(&plan) == awaits)
        || async_cfg::plan(function).is_some_and(|plan| async_cfg::count(&plan) == awaits)
}

pub(crate) struct RustEmission {
    pub source: String,
    pub function_ranges: Vec<RustFunctionRange>,
    pub function_body_bytes: std::collections::BTreeMap<String, usize>,
    pub section_bytes: std::collections::BTreeMap<String, usize>,
    pub abi_and_root_bytes: usize,
    pub adapter_definitions: usize,
    pub retained_adapters: usize,
    pub removed_adapter_bytes: usize,
    pub removed_dead_locals: usize,
    pub removed_dead_local_declarations: usize,
    pub removed_dead_local_assignments: usize,
    pub preserved_dead_local_effects: usize,
    pub callable_functions: usize,
    pub direct_only_functions: usize,
    pub function_abi_types: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RustFunctionRange {
    pub source_file: String,
    pub start: usize,
    pub end: usize,
}

#[cfg(test)]
pub fn rust(module: &Module) -> Result<String, String> {
    rust_with_metrics(module).map(|emission| emission.source)
}

pub(crate) fn rust_with_metrics(module: &Module) -> Result<RustEmission, String> {
    let tracing = std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1");
    let mut stamp = std::time::Instant::now();
    let mut mark = |name: &str| {
        if tracing {
            eprintln!(
                "scriptc: emission {name} ({} ms)",
                stamp.elapsed().as_millis()
            );
        }
        stamp = std::time::Instant::now();
    };
    let mut normalized = module.clone();
    generators::normalize(&mut normalized);
    async_normalize::normalize(&mut normalized);
    mark("normalization");
    let dead_locals = crate::ir::optimize::eliminate_dead_locals(&mut normalized);
    if std::env::var("SCRIPTC_TRACE_DCE").is_ok_and(|value| value == "1") {
        eprintln!(
            "scriptc: DCE removed {} locals, {} declarations, and {} assignments; preserved {} effectful expressions",
            dead_locals.locals,
            dead_locals.declarations,
            dead_locals.assignments,
            dead_locals.preserved_effects
        );
    }
    mark("dead local elimination");
    async_finally::rewrite_unplannable(&mut normalized, async_plannable);
    if let Some(path) = std::env::var_os("SCRIPTC_TRACE_NORMALIZED_IR") {
        let json = serde_json::to_vec_pretty(&normalized).map_err(|error| error.to_string())?;
        std::fs::write(path, json).map_err(|error| error.to_string())?;
    }
    let module = &normalized;
    crate::ir::validate(module)?;
    mark("validation");
    let mut suspension_errors = Vec::new();
    for function in &module.functions {
        if function.generator.is_some() && !generators::supported(function) {
            suspension_errors.push(format!(
                "native generator suspension requires continuation lowering: {} ({}) at {:?}",
                function.name,
                generators::unsupported_reason(function),
                function.loc
            ));
        }
        if function.generator.is_some() {
            continue;
        }
        let mut awaits = 0;
        function.visit_expressions(&mut |expr| {
            awaits += usize::from(matches!(expr, Expr::Await { .. }))
        });
        let terminal = matches!(
            function.body.last(),
            Some(Stmt::Return {
                value: Some(Expr::Await { .. }),
                ..
            })
        );
        let local_await = simple_await_local(function).is_some();
        let protected_await = protected_await_return(function).is_some();
        let protected_catch = protected_catch_await(function).is_some();
        let protected_two = protected_two_awaits(function).is_some();
        let protected_linear = protected_linear::plan(function)
            .is_some_and(|plan| protected_linear::count(&plan) == awaits);
        let protected_exit = protected_exit::plan(function)
            .is_some_and(|plan| protected_exit::count(&plan) == awaits);
        let structured_async =
            async_cfg::plan(function).is_some_and(|plan| async_cfg::count(&plan) == awaits);
        let safe_prefix = terminal_await_prefix_supported(
            &function.body[..function.body.len().saturating_sub(1)],
        );
        if awaits != 0
            && (!function.is_async
                || !((awaits == 1
                    && function.is_async
                    && ((terminal && safe_prefix)
                        || local_await
                        || protected_await
                        || protected_catch))
                    || (awaits == 2 && protected_two)
                    || protected_linear
                    || protected_exit
                    || structured_async))
        {
            if std::env::var("SCRIPTC_TRACE_ASYNC_PLAN").is_ok_and(|value| value == "1") {
                eprintln!(
                    "scriptc: rejected async plan for {} (awaits={awaits}, terminal={terminal}, local={local_await}, protected={protected_await}, catch={protected_catch}, two={protected_two}, linear={protected_linear}, exit={protected_exit}, cfg={structured_async})\n{function:#?}",
                    function.name
                );
            }
            suspension_errors.push(format!(
                "native async suspension requires continuation lowering: {} ({}, awaits={awaits}, terminal={terminal}, local={local_await}, protected={protected_await}, catch={protected_catch}, two={protected_two}, linear={protected_linear}, exit={protected_exit}, cfg={structured_async}) at {:?}",
                function.name,
                generators::unsupported_reason(function),
                function.loc
            ));
        }
    }
    if !suspension_errors.is_empty() {
        return Err(suspension_errors.join("\n"));
    }
    mark("continuation planning");
    let emission = Emission::new(module);
    mark("inventories");
    let module = &emission;
    let mut rejection_listeners = false;
    let mut uncaught_listeners = false;
    let mut uncaught_monitors = false;
    let mut exit_listeners = false;
    module.visit_expressions(&mut |expr| {
        if matches!(expr, Expr::LibCall { r#fn, .. } if r#fn == "process.onUnhandledRejection") {
            rejection_listeners = true;
        }
        if matches!(expr, Expr::LibCall { r#fn, .. } if r#fn == "process.onUncaughtException") {
            uncaught_listeners = true;
        }
        if matches!(expr, Expr::LibCall { r#fn, .. } if matches!(r#fn.as_str(), "process.onUncaughtMonitor" | "process.offUncaughtMonitor")) {
            uncaught_monitors = true;
        }
        if matches!(expr, Expr::LibCall { r#fn, .. } if matches!(r#fn.as_str(), "process.onExit" | "process.offExit")) {
            exit_listeners = true;
        }
    });
    let mut section_bytes = std::collections::BTreeMap::<String, usize>::new();
    let mut section_start = 0usize;
    let mut finish_section = |name: &str, end: usize| {
        section_bytes.insert(name.to_owned(), end.saturating_sub(section_start));
        section_start = end;
    };
    let mut output = String::from(
        "// scriptc native IR v13; engine: none\n#![forbid(unsafe_code)]\n#![allow(warnings)]\n",
    );
    output.push_str(include_str!("program_support.rs"));
    finish_section("preamble", output.len());
    if uses_runtime(module) {
        output.push_str("\nuse scriptc_runtime as runtime;\nuse runtime::JsStringSource;\n");
        output.push_str(include_str!("heap_support.rs"));
        output.push_str(include_str!("collections_support.rs"));
        finish_section("shared support", output.len());
        layouts::definitions(module, &mut output);
        finish_section("layouts", output.len());
        mark("layouts");
        classes::definitions(module, &mut output);
        finish_section("classes", output.len());
        mark("classes");
        functions::definitions(module, &mut output);
        finish_section("function identities", output.len());
        mark("function identities");
        values::definitions(module, &mut output);
        finish_section("dynamic values", output.len());
        mark("dynamic values");
        process::definitions(module, &mut output);
        if rejection_listeners || uncaught_listeners || uncaught_monitors || exit_listeners {
            output.push_str(include_str!("emit/process_rejection_support.rs"));
        }
        buffer_values::definitions(module, &mut output);
        iteration::definitions(module, &mut output);
        collections::definitions(module, &mut output);
        sets::definitions(module, &mut output);
        exceptions::definitions(module, &mut output);
        finish_section("runtime support", output.len());
        mark("runtime support");
        for (index, function) in module.functions.iter().enumerate() {
            if function.generator.is_some() {
                continue;
            }
            if let Some(plan) = simple_await_local(function) {
                emit_await_frame(index, function, &plan, module, &mut output);
            }
            if let Some(plan) = protected_two_awaits(function) {
                emit_protected_two_frame(index, function, &plan, module, &mut output);
            }
            if let Some(plan) = protected_linear::plan(function) {
                protected_linear::definitions(index, &plan, function, module, &mut output);
            }
            if let Some(plan) = protected_exit::plan(function) {
                protected_exit::definitions(index, &plan, function, module, &mut output);
            }
            if let Some(plan) = async_cfg::plan(function) {
                async_cfg::definitions(index, &plan, function, module, &mut output);
            }
            if let Some((_, fallback)) = protected_await_return(function) {
                emit_protected_one_frame(index, function, fallback, module, &mut output);
            }
            if let Some(plan) = protected_catch_await(function) {
                emit_protected_catch_frame(index, function, &plan, module, &mut output);
            }
        }
        child_process::definitions(module, &mut output);
        filesystem_values::definitions(module, &mut output);
        json_functions::definitions(module, &mut output);
        finish_section("continuation frames", output.len());
        mark("continuation frames");
    }
    storage::definitions(module, &mut output);
    finish_section("storage", output.len());
    mark("storage");
    let entry = module
        .functions
        .iter()
        .find(|function| function.name == module.entry);
    let entry_initializer_count = entry.map_or(0, |function| {
        function
            .body
            .iter()
            .take_while(|statement| {
                matches!(
                    statement,
                    Stmt::Assign {
                        initializes_global: true,
                        ..
                    }
                )
            })
            .count()
    });
    const ENTRY_INITIALIZER_CHUNK: usize = 64;
    if entry_initializer_count >= ENTRY_INITIALIZER_CHUNK * 2 {
        let function = entry.expect("entry initializer count requires an entry function");
        for (chunk_index, chunk) in function.body[..entry_initializer_count]
            .chunks(ENTRY_INITIALIZER_CHUNK)
            .enumerate()
        {
            output.push_str(&format!(
                "fn native_entry_initializers_{chunk_index}() {{\n"
            ));
            for stmt in chunk {
                statement(stmt, function, module, &mut output);
            }
            output.push_str("}\n");
        }
    }
    finish_section("entry initializers", output.len());
    let mut function_body_bytes = std::collections::BTreeMap::<String, usize>::new();
    let mut function_ranges = Vec::with_capacity(module.functions.len());
    for (function_index, function) in module.functions.iter().enumerate() {
        let function_start = output.len();
        let mut await_count = 0;
        function.visit_expressions(&mut |value| {
            await_count += usize::from(matches!(value, Expr::Await { .. }));
        });
        let params = function
            .params
            .iter()
            .map(|p| {
                format!(
                    "mut {}: {}",
                    p.local_id,
                    if classes::lazy_constructor_capture(function, &p.local_id, module) {
                        "NativeClassCapture".into()
                    } else {
                        rust_type(p.r#type.clone(), module)
                    }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let captures = function
            .captures
            .iter()
            .flatten()
            .map(|p| {
                format!(
                    "{}: runtime::Gc<NativeCell<{}>>, ",
                    p.local_id,
                    rust_type(p.r#type.clone(), module)
                )
            })
            .collect::<String>();
        let receiver = if function.reads_receiver() {
            "native_this: NativeValue, "
        } else {
            ""
        };
        output.push_str(&format!(
            "\nfn {}({receiver}{captures}{params}) -> {} {{\n",
            function_name(&function.name),
            rust_type(function.call_result(), module)
        ));
        if function.generator.is_some() {
            generators::body(function, module, &mut output);
            output.push_str("}\n");
            *function_body_bytes
                .entry(function.loc.file.clone())
                .or_default() += output.len() - function_start;
            function_ranges.push(RustFunctionRange {
                source_file: function.loc.file.clone(),
                start: function_start,
                end: output.len(),
            });
            continue;
        }
        let terminal_await = match function.body.last() {
            Some(Stmt::Return {
                value: Some(Expr::Await { value, .. }),
                ..
            }) if function.is_async && await_count == 1 => Some(value.as_ref()),
            _ => None,
        };
        let local_await = (await_count == 1)
            .then(|| simple_await_local(function))
            .flatten();
        let protected_await = (await_count == 1)
            .then(|| protected_await_return(function))
            .flatten();
        let protected_catch = (await_count == 1)
            .then(|| protected_catch_await(function))
            .flatten();
        let protected_two = (await_count == 2)
            .then(|| protected_two_awaits(function))
            .flatten();
        let protected_linear = protected_linear::plan(function)
            .filter(|plan| protected_linear::count(plan) == await_count);
        let protected_exit = protected_exit::plan(function)
            .filter(|plan| protected_exit::count(plan) == await_count);
        let structured_async =
            async_cfg::plan(function).filter(|plan| async_cfg::count(plan) == await_count);
        if function.is_async {
            if terminal_await.is_some()
                || local_await.is_some()
                || protected_await.is_some()
                || protected_catch.is_some()
                || protected_two.is_some()
                || protected_linear.is_some()
                || protected_exit.is_some()
                || structured_async.is_some()
            {
                output.push_str("let result = runtime::promise_new(); let target = result.clone(); native_async_segment(&target, || {\n");
            } else {
                output.push_str("let result = runtime::promise_new(); let target = result.clone(); native_async_segment(&target, || { let value = (|| {\n");
            }
        }
        for param in &function.params {
            if function
                .locals
                .iter()
                .any(|l| l.id == param.local_id && l.boxed)
            {
                output.push_str(&format!(
                    "let {} = native_cell({});\n",
                    param.local_id, param.local_id
                ));
            }
        }
        let statements = if let Some(plan) = &protected_catch {
            plan.prefix
        } else if protected_linear.is_some()
            || protected_exit.is_some()
            || structured_async.is_some()
            || protected_await.is_some()
            || protected_two.is_some()
        {
            &function.body[..0]
        } else if let Some(plan) = &local_await {
            &function.body[..plan.index]
        } else if terminal_await.is_some() {
            &function.body[..function.body.len() - 1]
        } else {
            &function.body[..]
        };
        let split_entry_initializers = function.name == module.entry
            && entry_initializer_count >= ENTRY_INITIALIZER_CHUNK * 2
            && statements.len() >= entry_initializer_count;
        for (statement_index, stmt) in statements.iter().enumerate() {
            if split_entry_initializers && statement_index < entry_initializer_count {
                if statement_index.is_multiple_of(ENTRY_INITIALIZER_CHUNK) {
                    output.push_str(&format!(
                        "native_entry_initializers_{}();\n",
                        statement_index / ENTRY_INITIALIZER_CHUNK
                    ));
                }
                continue;
            }
            statement(stmt, function, module, &mut output);
        }
        if function.is_async {
            if let Some(plan) = protected_catch {
                let promise = expr(plan.awaited, function, module);
                let captures = plan
                    .captures
                    .iter()
                    .enumerate()
                    .map(|(i, capture)| format!("c{i}: Some({}.clone()),", capture.id))
                    .collect::<String>();
                output.push_str(&format!("let source = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {promise})); match source {{ Ok(source) => {{ let frame = runtime::Gc::new(NativeProtectedCatch{function_index} {{ target: Some(result.clone()), {captures} }}); runtime::promise_then_traced(&source, frame, native_protected_catch_{function_index}); }}, Err(payload) => {{ let reason = runtime::caught_from_panic(payload); let frame = runtime::Gc::new(NativeProtectedCatch{function_index} {{ target: Some(result.clone()), {captures} }}); native_protected_catch_{function_index}(frame, Err(reason)); }} }} }}); result\n"));
            } else if let Some(plan) = protected_exit {
                protected_exit::start(function_index, &plan, function, module, &mut output);
            } else if let Some(plan) = protected_linear {
                protected_linear::start(function_index, &plan, function, module, &mut output);
            } else if let Some(plan) = structured_async {
                async_cfg::start(function_index, &plan, function, module, &mut output);
            } else if let Some(plan) = protected_two {
                let first = expr(plan.first, function, module);
                let fallback = expr(plan.fallback, function, module);
                let boxed = values::box_value(&function.return_type, "value", module);
                let captures = plan
                    .captures
                    .iter()
                    .enumerate()
                    .map(|(i, local)| format!("c{i}: Some({}.clone()),", local.id))
                    .collect::<String>();
                output.push_str(&format!("let source = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {first})); match source {{ Ok(source) => {{ let frame = runtime::Gc::new(NativeProtectedAwait{function_index} {{ target: Some(result.clone()), {captures} }}); runtime::promise_then_traced(&source, frame, native_protected_first_{function_index}); }}, Err(payload) => {{ let _ = runtime::caught_from_panic(payload); let value = {fallback}; let value = {boxed}; native_promise_plain(&value); let _ = runtime::promise_fulfill(&result, value); }} }} }}); result\n"));
            } else if let Some((awaited, fallback)) = protected_await {
                let promise = expr(awaited, function, module);
                let fallback = expr(fallback, function, module);
                let boxed = values::box_value(&function.return_type, "value", module);
                output.push_str(&format!("let source = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {promise})); match source {{ Ok(source) => {{ let frame = runtime::Gc::new(NativeProtectedAwait{function_index} {{ target: Some(result.clone()) }}); runtime::promise_then_traced(&source, frame, native_protected_one_{function_index}); }}, Err(payload) => {{ let _ = runtime::caught_from_panic(payload); let value = {fallback}; let value = {boxed}; native_promise_plain(&value); let _ = runtime::promise_fulfill(&result, value); }} }} }}); result\n"));
            } else if let Some(plan) = local_await {
                let promise = expr(plan.awaited, function, module);
                let captures = plan
                    .captures
                    .iter()
                    .enumerate()
                    .map(|(index, local)| format!("c{index}: Some({}.clone()),", local.id))
                    .collect::<String>();
                output.push_str(&format!("let source = {promise}; let frame = runtime::Gc::new(NativeAwaitFrame{function_index} {{ target: Some(result.clone()), {captures} }}); runtime::promise_then_traced(&source, frame, native_await_resume_{function_index}); }}); result\n"));
            } else if let Some(awaited) = terminal_await {
                let promise = expr(awaited, function, module);
                let check = if function.return_type == Type::Void {
                    String::new()
                } else {
                    format!(
                        "let _ = {};",
                        values::checked_value(&function.return_type, "value.clone()", module)
                    )
                };
                output.push_str(&format!("let source = {promise}; let continuation = result.clone(); runtime::promise_then(&source, Box::new(move |outcome| {{ let destination = continuation.clone(); runtime::promise_run_segment(&destination, move || match outcome {{ Ok(value) => {{ {check} let _ = runtime::promise_fulfill(&continuation, value); }}, Err(reason) => {{ let _ = runtime::promise_reject(&continuation, reason); }} }}); }})); }}); result\n"));
            } else {
                output.push_str("})();\n");
                let boxed = if function.return_type == Type::Void {
                    "NativeValue::Undefined".into()
                } else {
                    values::box_value(&function.return_type, "value", module)
                };
                output.push_str(&format!("let value = {boxed}; native_promise_plain(&value); let _ = runtime::promise_fulfill(&result, value); }}); result\n"));
            }
        }
        output.push_str("}\n");
        *function_body_bytes
            .entry(function.loc.file.clone())
            .or_default() += output.len() - function_start;
        function_ranges.push(RustFunctionRange {
            source_file: function.loc.file.clone(),
            start: function_start,
            end: output.len(),
        });
    }
    finish_section("function bodies", output.len());
    if uses_runtime(module) {
        let full_lifecycle = needs_full_lifecycle(module);
        let clear_listeners =
            if rejection_listeners || uncaught_listeners || uncaught_monitors || exit_listeners {
                "clear_native_rejection_listeners();"
            } else {
                ""
            };
        let entry_async = module
            .functions
            .iter()
            .find(|function| function.name == module.entry)
            .is_some_and(|function| function.is_async);
        let run = if entry_async && (uncaught_listeners || uncaught_monitors) {
            format!(
                "let root = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {}())); let root = match root {{ Ok(root) => Some(root), Err(payload) => {{ let caught = runtime::caught_from_panic(payload); if !native_process_dispatch_uncaught(caught.clone()) {{ runtime::rethrow_caught(caught); }} None }} }}; let root_outcome: std::rc::Rc<std::cell::RefCell<Option<Result<NativeValue, runtime::Caught>>>> = std::rc::Rc::new(std::cell::RefCell::new(None)); if let Some(root) = &root {{ let observed = root_outcome.clone(); runtime::promise_then(root, Box::new(move |outcome| *observed.borrow_mut() = Some(outcome))); }} runtime::run_event_loop_with_uncaught_handler(|caught| {{ if native_process_uncaught_active() || !native_process_dispatch_uncaught(caught.clone()) {{ runtime::rethrow_caught(caught); }} }}); if root.is_some() {{ match root_outcome.borrow_mut().take() {{ Some(Ok(_)) => {{}}, Some(Err(reason)) => {{ if !native_process_dispatch_uncaught(reason.clone()) {{ runtime::rethrow_caught(reason); }} }}, None => pending_root = true }} }};",
                module.entry
            )
        } else if entry_async {
            format!(
                "let root = {}(); let _ = runtime::promise_poll(&root); runtime::run_event_loop(); match runtime::promise_poll(&root) {{ Some(Ok(_)) => {{}}, Some(Err(reason)) => runtime::rethrow_caught(reason), None => pending_root = true }};",
                module.entry
            )
        } else if uncaught_listeners || uncaught_monitors {
            format!(
                "if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {}())) {{ let caught = runtime::caught_from_panic(payload); if !native_process_dispatch_uncaught(caught.clone()) {{ runtime::rethrow_caught(caught); }} }} runtime::run_event_loop_with_uncaught_handler(|caught| {{ if native_process_uncaught_active() || !native_process_dispatch_uncaught(caught.clone()) {{ runtime::rethrow_caught(caught); }} }});",
                module.entry
            )
        } else if full_lifecycle {
            format!("{}(); runtime::run_event_loop();", module.entry)
        } else {
            format!("{}();", module.entry)
        };
        let entry_script = entry_script_statement(module);
        let dispatch_exit = if exit_listeners {
            "native_process_dispatch_exit();"
        } else {
            ""
        };
        let init = if full_lifecycle { "init" } else { "init_sync" };
        let finish = if full_lifecycle {
            "finish"
        } else {
            "finish_sync"
        };
        output.push_str(&format!("\nfn main() {{ runtime::{init}(); {entry_script} let mut pending_root = false; let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ {run} {dispatch_exit} }})); {clear_listeners} clear_module_storage(); clear_function_storage(); clear_native_instance_method_properties(); clear_native_global_object(); let error = outcome.err().map(|payload| {{ let caught = runtime::caught_from_panic(payload); native_exception_string(&caught) }}); let failed = runtime::had_unhandled_rejection(); let exit_code = runtime::process_exit_code(); clear_native_object_prototypes(); runtime::{finish}(); if let Some(error) = error {{ eprintln!(\"Uncaught {{error}}\"); std::process::exit(1); }} if failed {{ std::process::exit(1); }} if pending_root {{ std::process::exit(13); }} if exit_code != 0 {{ std::process::exit(exit_code); }} }}\n"));
    } else {
        output.push_str(&format!("\nfn main() {{ {}(); }}\n", module.entry));
    }
    finish_section("root", output.len());
    let (output, adapter_pruning) = values::prune_unused_adapters(output);
    for range in &mut function_ranges {
        range.start = range
            .start
            .checked_sub(adapter_pruning.removed_bytes)
            .expect("value adapters precede emitted function bodies");
        range.end = range
            .end
            .checked_sub(adapter_pruning.removed_bytes)
            .expect("value adapters precede emitted function bodies");
    }
    if adapter_pruning.removed_bytes != 0 {
        let dynamic_values = section_bytes
            .get_mut("dynamic values")
            .expect("value adapters belong to the dynamic value section");
        *dynamic_values = dynamic_values
            .checked_sub(adapter_pruning.removed_bytes)
            .expect("removed adapter bytes fit the dynamic value section");
    }
    let body_bytes = function_body_bytes.values().sum::<usize>();
    debug_assert_eq!(section_bytes.values().sum::<usize>(), output.len());
    Ok(RustEmission {
        abi_and_root_bytes: output.len().saturating_sub(body_bytes),
        source: output,
        function_ranges,
        function_body_bytes,
        section_bytes,
        adapter_definitions: adapter_pruning.discovered,
        retained_adapters: adapter_pruning.retained,
        removed_adapter_bytes: adapter_pruning.removed_bytes,
        removed_dead_locals: dead_locals.locals,
        removed_dead_local_declarations: dead_locals.declarations,
        removed_dead_local_assignments: dead_locals.assignments,
        preserved_dead_local_effects: dead_locals.preserved_effects,
        callable_functions: module.callable_function_count(),
        direct_only_functions: module
            .functions
            .iter()
            .filter(|function| {
                function.name != module.entry && !module.callable_function(&function.name)
            })
            .count(),
        function_abi_types: module.function_types().len(),
    })
}

struct SimpleAwaitLocal<'a> {
    index: usize,
    local_id: &'a str,
    awaited: &'a Expr,
    projection: Option<&'a Expr>,
    effects: &'a [Stmt],
    result: Option<&'a Expr>,
    captures: Vec<&'a crate::ir::Local>,
}

/// A single protected terminal await, with a literal catch result, needs no
/// captured locals. More general protected regions require a state machine.
fn protected_await_return(function: &Function) -> Option<(&Expr, &Expr)> {
    if !function.is_async || function.return_type == Type::Void {
        return None;
    }
    let [
        Stmt::TryCatch {
            try_body,
            catch_body: Some(catch),
            catch_local_id: None,
            finally_body: None,
            ..
        },
    ] = function.body.as_slice()
    else {
        return None;
    };
    let [
        Stmt::Return {
            value: Some(Expr::Await { value, .. }),
            ..
        },
    ] = try_body.as_slice()
    else {
        return None;
    };
    let [
        Stmt::Return {
            value: Some(fallback),
            ..
        },
    ] = catch.as_slice()
    else {
        return None;
    };
    fn literal_fallback(value: &Expr) -> bool {
        match value {
            Expr::NumLit { .. }
            | Expr::StrLit { .. }
            | Expr::BoolLit { .. }
            | Expr::UnitLit { .. } => true,
            Expr::UnionWrap { value, .. } => literal_fallback(value),
            _ => false,
        }
    }
    if !literal_fallback(fallback) {
        return None;
    }
    Some((value, fallback))
}

fn emit_protected_one_frame(
    index: usize,
    function: &Function,
    fallback: &Expr,
    module: &Emission<'_>,
    output: &mut String,
) {
    let fallback = expr(fallback, function, module);
    let boxed = values::box_value(&function.return_type, "value", module);
    let checked = values::checked_value(&function.return_type, "value.clone()", module);
    output.push_str(&format!("struct NativeProtectedAwait{index} {{ target: Option<runtime::JsPromise<NativeValue>> }}\nimpl runtime::Trace for NativeProtectedAwait{index} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ if let Some(target) = &self.target {{ target.trace_native(tracer); }} }} }}\nimpl runtime::ClearEdges for NativeProtectedAwait{index} {{ fn clear_edges(&mut self) {{ self.target = None; }} }}\n"));
    output.push_str(&format!("fn native_protected_one_{index}(frame: runtime::Gc<NativeProtectedAwait{index}>, outcome: Result<NativeValue, runtime::Caught>) {{ let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared protected target\").clone()); let guard = target.clone(); runtime::promise_run_segment(&guard, move || match outcome {{ Ok(value) => {{ let _ = {checked}; let _ = runtime::promise_fulfill(&target, value); }}, Err(_) => {{ let value = {fallback}; let value = {boxed}; native_promise_plain(&value); let _ = runtime::promise_fulfill(&target, value); }} }}); }}\n"));
}

struct ProtectedCatchCapture<'a> {
    id: &'a str,
    ty: &'a Type,
    boxed: bool,
    mutable: bool,
}

struct ProtectedCatchAwait<'a> {
    prefix: &'a [Stmt],
    awaited: &'a Expr,
    catch: &'a [Stmt],
    catch_local_id: &'a str,
    captures: Vec<ProtectedCatchCapture<'a>>,
}

fn protected_catch_await(function: &Function) -> Option<ProtectedCatchAwait<'_>> {
    if !function.is_async {
        return None;
    }
    let (region, protected) = function.body.split_last()?;
    let Stmt::TryCatch {
        try_body,
        catch_body: Some(catch),
        catch_local_id: Some(catch_local_id),
        finally_body: None,
        ..
    } = region
    else {
        return None;
    };
    let [
        Stmt::Return {
            value: Some(Expr::Await { value: awaited, .. }),
            ..
        },
    ] = try_body.as_slice()
    else {
        return None;
    };
    fn contains_return(body: &[Stmt]) -> bool {
        body.iter().any(|stmt| match stmt {
            Stmt::Return { .. } => true,
            Stmt::Block { body, .. } | Stmt::While { body, .. } => contains_return(body),
            Stmt::If { then, else_, .. } => {
                contains_return(then) || else_.as_ref().is_some_and(|body| contains_return(body))
            }
            Stmt::Switch { cases, .. } => cases.iter().any(|case| contains_return(&case.body)),
            Stmt::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                contains_return(try_body)
                    || catch_body
                        .as_ref()
                        .is_some_and(|body| contains_return(body))
                    || finally_body
                        .as_ref()
                        .is_some_and(|body| contains_return(body))
            }
            _ => false,
        })
    }
    if contains_return(catch)
        || !always_returns(catch)
        || !protected
            .iter()
            .all(|stmt| matches!(stmt, Stmt::VarDecl { .. } | Stmt::Expression { .. }))
    {
        return None;
    }
    let mut ids = Vec::<&str>::new();
    for param in &function.params {
        ids.push(&param.local_id);
    }
    for capture in function.captures.iter().flatten() {
        if !ids.contains(&capture.local_id.as_str()) {
            ids.push(&capture.local_id);
        }
    }
    for stmt in protected {
        if let Stmt::VarDecl { local_id, .. } = stmt
            && !ids.contains(&local_id.as_str())
        {
            ids.push(local_id);
        }
    }
    let captures = ids
        .into_iter()
        .filter_map(|id| {
            if let Some(local) = function.locals.iter().find(|local| local.id == id) {
                return Some(ProtectedCatchCapture {
                    id,
                    ty: &local.r#type,
                    boxed: local.boxed,
                    mutable: local.mutable,
                });
            }
            function
                .captures
                .iter()
                .flatten()
                .find(|capture| capture.local_id == id)
                .map(|capture| ProtectedCatchCapture {
                    id,
                    ty: &capture.r#type,
                    boxed: true,
                    mutable: false,
                })
        })
        .collect();
    Some(ProtectedCatchAwait {
        prefix: protected,
        awaited,
        catch,
        catch_local_id,
        captures,
    })
}

fn emit_protected_catch_frame(
    index: usize,
    function: &Function,
    plan: &ProtectedCatchAwait<'_>,
    module: &Emission<'_>,
    output: &mut String,
) {
    let name = format!("NativeProtectedCatch{index}");
    output.push_str(&format!(
        "struct {name} {{ target: Option<runtime::JsPromise<NativeValue>>,\n"
    ));
    for (i, capture) in plan.captures.iter().enumerate() {
        let ty = rust_type(capture.ty.clone(), module);
        let ty = if capture.boxed {
            format!("runtime::Gc<NativeCell<{ty}>>")
        } else {
            ty
        };
        output.push_str(&format!("c{i}: Option<{ty}>,\n"));
    }
    output.push_str(&format!("}}\nimpl runtime::Trace for {name} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ if let Some(value) = &self.target {{ value.trace_native(tracer); }}"));
    for i in 0..plan.captures.len() {
        output.push_str(&format!(
            "if let Some(value) = &self.c{i} {{ value.trace_native(tracer); }}"
        ));
    }
    output.push_str(&format!("}} }}\nimpl runtime::ClearEdges for {name} {{ fn clear_edges(&mut self) {{ self.target = None;"));
    for i in 0..plan.captures.len() {
        output.push_str(&format!("self.c{i} = None;"));
    }
    output.push_str("} }\n");
    output.push_str(&format!("fn native_protected_catch_{index}(frame: runtime::Gc<{name}>, outcome: Result<NativeValue, runtime::Caught>) {{\n"));
    output.push_str("let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared protected catch target\").clone());\n");
    for (i, capture) in plan.captures.iter().enumerate() {
        let mutable = if capture.mutable && !capture.boxed {
            "mut "
        } else {
            ""
        };
        output.push_str(&format!("let {mutable}{} = frame.with(|frame| frame.c{i}.as_ref().expect(\"scriptc: cleared protected catch capture\").clone());\n", capture.id));
    }
    let checked = values::checked_value(&function.return_type, "value.clone()", module);
    let mut catch = String::new();
    for item in plan.catch {
        statement(item, function, module, &mut catch);
    }
    output.push_str(&format!("let guard = target.clone(); runtime::promise_run_segment(&guard, move || match outcome {{ Ok(value) => {{ let _ = {checked}; let _ = runtime::promise_fulfill(&target, value); }}, Err(reason) => {{ let {} = native_caught(reason.clone()); {catch} let _ = runtime::promise_reject(&target, reason); }} }}); }}\n", plan.catch_local_id));
}

struct ProtectedTwoAwait<'a> {
    first: &'a Expr,
    second: &'a Expr,
    local: &'a crate::ir::Local,
    fallback: &'a Expr,
    captures: Vec<&'a crate::ir::Local>,
}

fn protected_two_awaits(function: &Function) -> Option<ProtectedTwoAwait<'_>> {
    if !function.is_async || function.return_type != Type::F64 {
        return None;
    }
    let [
        Stmt::TryCatch {
            try_body,
            catch_body: Some(catch),
            catch_local_id: None,
            finally_body: None,
            ..
        },
    ] = function.body.as_slice()
    else {
        return None;
    };
    let [
        Stmt::VarDecl {
            local_id,
            init: Expr::Await { value: first, .. },
            ..
        },
        Stmt::Return {
            value: Some(Expr::Await { value: second, .. }),
            ..
        },
    ] = try_body.as_slice()
    else {
        return None;
    };
    let [
        Stmt::Return {
            value: Some(fallback @ Expr::NumLit { .. }),
            ..
        },
    ] = catch.as_slice()
    else {
        return None;
    };
    let local = function
        .locals
        .iter()
        .find(|local| &local.id == local_id && local.r#type == Type::F64 && !local.boxed)?;
    let args = match second.as_ref() {
        Expr::Intrinsic { name, args, .. } if name == "promise.resolve" => args,
        Expr::Call { args, .. } => args,
        _ => return None,
    };
    let mut captures = Vec::new();
    for argument in args {
        match argument {
            Expr::VarRef { local_id: id, .. } if id == local_id => {}
            Expr::VarRef { local_id: id, .. }
                if function.params.iter().any(|param| &param.local_id == id) =>
            {
                let capture = function.locals.iter().find(|local| &local.id == id)?;
                if !captures
                    .iter()
                    .any(|existing: &&crate::ir::Local| existing.id == capture.id)
                {
                    captures.push(capture);
                }
            }
            Expr::NumLit { .. } | Expr::StrLit { .. } | Expr::BoolLit { .. } => {}
            _ => return None,
        }
    }
    Some(ProtectedTwoAwait {
        first,
        second,
        local,
        fallback,
        captures,
    })
}

fn emit_protected_two_frame(
    index: usize,
    function: &Function,
    plan: &ProtectedTwoAwait<'_>,
    module: &Emission<'_>,
    output: &mut String,
) {
    let fallback = expr(plan.fallback, function, module);
    let boxed = values::box_value(&function.return_type, "value", module);
    let first_value = values::checked_value(&plan.local.r#type, "value", module);
    let second_value = values::checked_value(&function.return_type, "value.clone()", module);
    let second = expr(plan.second, function, module);
    let local = &plan.local.id;
    output.push_str(&format!(
        "struct NativeProtectedAwait{index} {{ target: Option<runtime::JsPromise<NativeValue>>,\n"
    ));
    for (i, local) in plan.captures.iter().enumerate() {
        let ty = rust_type(local.r#type.clone(), module);
        let ty = if local.boxed {
            format!("runtime::Gc<NativeCell<{ty}>>")
        } else {
            ty
        };
        output.push_str(&format!("c{i}: Option<{ty}>,\n"));
    }
    output.push_str(&format!("}}\nimpl runtime::Trace for NativeProtectedAwait{index} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ if let Some(target) = &self.target {{ target.trace_native(tracer); }}"));
    for i in 0..plan.captures.len() {
        output.push_str(&format!(
            "if let Some(value) = &self.c{i} {{ value.trace_native(tracer); }}"
        ));
    }
    output.push_str(&format!("}} }}\nimpl runtime::ClearEdges for NativeProtectedAwait{index} {{ fn clear_edges(&mut self) {{ self.target = None;"));
    for i in 0..plan.captures.len() {
        output.push_str(&format!("self.c{i} = None;"));
    }
    output.push_str("} }\n");
    output.push_str(&format!("fn native_protected_catch_{index}(target: &runtime::JsPromise<NativeValue>) {{ let value = {fallback}; let value = {boxed}; native_promise_plain(&value); let _ = runtime::promise_fulfill(target, value); }}\n"));
    output.push_str(&format!("fn native_protected_first_{index}(frame: runtime::Gc<NativeProtectedAwait{index}>, outcome: Result<NativeValue, runtime::Caught>) {{ let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared protected target\").clone());\n"));
    for (i, captured) in plan.captures.iter().enumerate() {
        let mutable = if captured.mutable && !captured.boxed {
            "mut "
        } else {
            ""
        };
        output.push_str(&format!("let {mutable}{} = frame.with(|frame| frame.c{i}.as_ref().expect(\"scriptc: cleared protected capture\").clone());\n", captured.id));
    }
    output.push_str(&format!("let guard = target.clone(); runtime::promise_run_segment(&guard, move || match outcome {{ Err(_) => native_protected_catch_{index}(&target), Ok(value) => {{ let source = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ let {local} = {first_value}; {second} }})); match source {{ Ok(source) => runtime::promise_then_traced(&source, frame, native_protected_second_{index}), Err(payload) => {{ let _ = runtime::caught_from_panic(payload); native_protected_catch_{index}(&target); }} }} }} }}); }}\n"));
    output.push_str(&format!("fn native_protected_second_{index}(frame: runtime::Gc<NativeProtectedAwait{index}>, outcome: Result<NativeValue, runtime::Caught>) {{ let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared protected target\").clone()); let guard = target.clone(); runtime::promise_run_segment(&guard, move || match outcome {{ Err(_) => native_protected_catch_{index}(&target), Ok(value) => {{ let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ let _ = {second_value}; }})); match checked {{ Ok(()) => {{ let _ = runtime::promise_fulfill(&target, value); }}, Err(payload) => {{ let _ = runtime::caught_from_panic(payload); native_protected_catch_{index}(&target); }} }} }} }}); }}\n"));
}

fn simple_await_local(function: &Function) -> Option<SimpleAwaitLocal<'_>> {
    if !function.is_async {
        return None;
    }
    let index = function.body.iter().position(|stmt| {
        matches!(
            stmt,
            Stmt::VarDecl {
                init: Expr::Await { .. },
                ..
            }
        ) || matches!(stmt, Stmt::VarDecl { init: Expr::RecordGet { obj, .. }, .. } if matches!(obj.as_ref(), Expr::Await { .. }))
    })?;
    let Stmt::VarDecl { local_id, init, .. } = &function.body[index] else {
        return None;
    };
    let (value, projection) = match init {
        Expr::Await { value, .. } => (value, None),
        Expr::RecordGet { obj, .. } => match obj.as_ref() {
            Expr::Await { value, .. } => (value, Some(init)),
            _ => return None,
        },
        _ => return None,
    };
    let (effects, result) = match function.body.last()? {
        Stmt::Return { value, .. } if index + 1 < function.body.len() => (
            &function.body[index + 1..function.body.len() - 1],
            value.as_ref(),
        ),
        _ if function.return_type == Type::Void => (&function.body[index + 1..], None),
        _ => return None,
    };
    let prefix = &function.body[..index];
    if (function.return_type == Type::Void) != result.is_none()
        || (function.name != "__main"
            && !prefix.iter().all(|stmt| {
                matches!(
                    stmt,
                    Stmt::VarDecl { .. }
                        | Stmt::Assign { .. }
                        | Stmt::Expression { .. }
                        | Stmt::If { .. }
                )
            }))
    {
        return None;
    }
    fn collect(expr: &Expr, refs: &mut Vec<String>) -> bool {
        match expr {
            Expr::VarRef { local_id, .. } => {
                if !refs.contains(local_id) {
                    refs.push(local_id.clone());
                }
                true
            }
            Expr::NumLit { .. } | Expr::StrLit { .. } | Expr::BoolLit { .. } => true,
            Expr::Closure { captures, .. } => {
                for local_id in captures {
                    if !refs.contains(local_id) {
                        refs.push(local_id.clone());
                    }
                }
                true
            }
            Expr::ArrayLit { elems, .. } => elems.iter().all(|elem| collect(elem, refs)),
            Expr::Bin { left, right, .. }
            | Expr::StrConcat { left, right, .. }
            | Expr::UnionEq { left, right, .. } => collect(left, refs) && collect(right, refs),
            Expr::DynFrom { value, .. }
            | Expr::DynCheck { value, .. }
            | Expr::UnionWrap { value, .. }
            | Expr::ToString { operand: value, .. }
            | Expr::Unary { operand: value, .. } => collect(value, refs),
            Expr::RecordGet { obj, .. } | Expr::FieldGet { obj, .. } => collect(obj, refs),
            Expr::DynKeyGet { value, key, .. }
            | Expr::RecordKeyGet {
                obj: value, key, ..
            } => collect(value, refs) && collect(key, refs),
            Expr::Call { args, .. }
            | Expr::VirtualCall { args, .. }
            | Expr::Intrinsic { args, .. } => args.iter().all(|arg| collect(arg, refs)),
            Expr::CallValue { callee, args, .. } => {
                collect(callee, refs) && args.iter().all(|arg| collect(arg, refs))
            }
            Expr::NewValue { callee, args, .. } => {
                collect(callee, refs) && args.iter().all(|arg| collect(arg, refs))
            }
            Expr::New { args, .. } => args.iter().all(|arg| collect(arg, refs)),
            Expr::ClassRef { .. } | Expr::ClassCreate { .. } => true,
            Expr::StringIntrinsic { receiver, args, .. } => {
                collect(receiver, refs) && args.iter().all(|arg| collect(arg, refs))
            }
            Expr::LibCall { r#fn, args, .. } => {
                r#fn != "dyn.this" && args.iter().all(|arg| collect(arg, refs))
            }
            _ => false,
        }
    }
    let mut refs = Vec::new();
    let mut post_locals = Vec::new();
    for effect in effects {
        match effect {
            Stmt::VarDecl { local_id, init, .. } if collect(init, &mut refs) => {
                post_locals.push(local_id)
            }
            Stmt::Expression {
                expr: Expr::Intrinsic { name, args, .. },
                ..
            } if matches!(
                name.as_str(),
                "console.log"
                    | "console.error"
                    | "console.log.format"
                    | "console.error.format"
                    | "console.log.spread"
                    | "console.error.spread"
            ) && args.iter().all(|arg| collect(arg, &mut refs)) =>
            {
                ()
            }
            Stmt::Expression {
                expr: Expr::LibCall { r#fn, args, .. },
                ..
            } if r#fn == "process.exit" && args.iter().all(|arg| collect(arg, &mut refs)) => (),
            Stmt::Expression { expr, .. } if collect(expr, &mut refs) => (),
            Stmt::Assign {
                local_id, value, ..
            } if collect(value, &mut refs) => {
                if !refs.contains(local_id) {
                    refs.push(local_id.clone());
                }
            }
            Stmt::RecordSet { obj, value, .. }
                if collect(obj, &mut refs) && collect(value, &mut refs) =>
            {
                ()
            }
            _ => return None,
        }
    }
    if result.is_some_and(|result| !collect(result, &mut refs)) {
        return None;
    }
    let captures = refs
        .iter()
        .filter(|id| *id != local_id && !post_locals.contains(id))
        .filter_map(|id| function.locals.iter().find(|local| &local.id == id))
        .collect();
    Some(SimpleAwaitLocal {
        index,
        local_id,
        awaited: value,
        projection,
        effects,
        result,
        captures,
    })
}

fn emit_await_frame(
    index: usize,
    function: &Function,
    plan: &SimpleAwaitLocal<'_>,
    module: &Emission<'_>,
    output: &mut String,
) {
    let name = format!("NativeAwaitFrame{index}");
    output.push_str(&format!(
        "struct {name} {{ target: Option<runtime::JsPromise<NativeValue>>,\n"
    ));
    for (i, local) in plan.captures.iter().enumerate() {
        let ty = rust_type(local.r#type.clone(), module);
        let ty = if local.boxed {
            format!("runtime::Gc<NativeCell<{ty}>>")
        } else {
            ty
        };
        output.push_str(&format!("c{i}: Option<{ty}>,\n"));
    }
    output.push_str(&format!("}}\nimpl runtime::Trace for {name} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ if let Some(value) = &self.target {{ value.trace_native(tracer); }}"));
    for i in 0..plan.captures.len() {
        output.push_str(&format!(
            "if let Some(value) = &self.c{i} {{ value.trace_native(tracer); }}"
        ));
    }
    output.push_str(&format!("}} }}\nimpl runtime::ClearEdges for {name} {{ fn clear_edges(&mut self) {{ self.target = None;"));
    for i in 0..plan.captures.len() {
        output.push_str(&format!("self.c{i} = None;"));
    }
    output.push_str("} }\n");
    output.push_str(&format!("fn native_await_resume_{index}(frame: runtime::Gc<{name}>, outcome: Result<NativeValue, runtime::Caught>) {{\n"));
    output.push_str("let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared await target\").clone());\n");
    for (i, local) in plan.captures.iter().enumerate() {
        let mutable = if local.mutable && !local.boxed {
            "mut "
        } else {
            ""
        };
        output.push_str(&format!("let {mutable}{} = frame.with(|frame| frame.c{i}.as_ref().expect(\"scriptc: cleared await capture\").clone());\n", local.id));
    }
    let local = function
        .locals
        .iter()
        .find(|local| local.id == plan.local_id)
        .expect("validated await local");
    let unboxed = if let Some(Expr::RecordGet {
        obj,
        shape_id,
        field,
        r#type,
        loc,
    }) = plan.projection
    {
        let namespace_type = obj.ty();
        let checked = values::checked_value(&namespace_type, "value", module);
        let projected = Expr::RecordGet {
            obj: Box::new(Expr::VarRef {
                local_id: "__await_namespace".into(),
                r#type: namespace_type,
                loc: loc.clone(),
            }),
            shape_id: shape_id.clone(),
            field: field.clone(),
            r#type: r#type.clone(),
            loc: loc.clone(),
        };
        format!(
            "{{ let __await_namespace = {checked}; {} }}",
            expr(&projected, function, module)
        )
    } else {
        values::checked_value(&local.r#type, "value", module)
    };
    let binding = if local.boxed {
        format!("native_cell({unboxed})")
    } else {
        unboxed
    };
    let returned = plan
        .result
        .map(|result| expr(result, function, module))
        .unwrap_or_else(|| "()".into());
    let boxed = if function.return_type == Type::Void {
        "NativeValue::Undefined".into()
    } else {
        values::box_value(&function.return_type, "returned", module)
    };
    let mut effects = String::new();
    for effect in plan.effects {
        statement(effect, function, module, &mut effects);
    }
    let mutable = if local.mutable && !local.boxed {
        "mut "
    } else {
        ""
    };
    output.push_str(&format!("let guard = target.clone(); runtime::promise_run_segment(&guard, move || match outcome {{ Ok(value) => {{ let {mutable}{} = {binding}; {effects} let returned = {returned}; let returned = {boxed}; native_promise_plain(&returned); let _ = runtime::promise_fulfill(&target, returned); }}, Err(reason) => {{ let _ = runtime::promise_reject(&target, reason); }} }}); }}\n", plan.local_id));
}

pub fn uses_runtime(module: &Module) -> bool {
    if module.functions.iter().any(|f| f.is_async) {
        return true;
    }
    fn expr(value: &Expr) -> bool {
        match value {
            Expr::StrLit { .. }
            | Expr::StrConcat { .. }
            | Expr::StrEq { .. }
            | Expr::ToString { .. }
            | Expr::DynFrom { .. }
            | Expr::DynCheck { .. }
            | Expr::DynIterN { .. }
            | Expr::DynObjLit { .. }
            | Expr::DynArrLit { .. }
            | Expr::DynKeyGet { .. }
            | Expr::DynTest { .. }
            | Expr::DynScalarEq { .. }
            | Expr::DynLooseEq { .. }
            | Expr::DynInvoke { .. }
            | Expr::DynCall { .. } => true,
            Expr::Intrinsic { name, .. }
                if name == "promise.resolve"
                    || name == "module.import.inert"
                    || name == "module.import.lazy"
                    || name == "module.import.cjs"
                    || name == "module.import.missing" =>
            {
                true
            }
            Expr::BytesNew { .. }
            | Expr::BytesIntrinsic { .. }
            | Expr::RegexLit { .. }
            | Expr::RegexIntrinsic { .. } => true,
            Expr::ClassRef { .. }
            | Expr::ClassCreate { .. }
            | Expr::NewValue { .. }
            | Expr::New { .. }
            | Expr::FieldGet { .. }
            | Expr::Upcast { .. }
            | Expr::Downcast { .. }
            | Expr::InstanceOf { .. }
            | Expr::VirtualCall { .. } => true,
            Expr::ArrayLit { .. }
            | Expr::LibCall { .. }
            | Expr::SetNew { .. }
            | Expr::SetIntrinsic { .. } => true,
            Expr::ArrayIntrinsic { .. } | Expr::StringIntrinsic { .. } => true,
            Expr::ArrayGet { .. } => true,
            Expr::MapNew { seed, .. } => seed.iter().any(|p| expr(&p.key) || expr(&p.value)),
            Expr::MapIntrinsic { receiver, args, .. } => expr(receiver) || args.iter().any(expr),
            Expr::RecordKeyGet { obj, key, .. } => expr(obj) || expr(key),
            Expr::Bin {
                op, left, right, ..
            } => {
                matches!(op.as_str(), "&" | "|" | "^" | "<<" | ">>" | ">>>")
                    || expr(left)
                    || expr(right)
            }
            Expr::UnionEq { left, right, .. } | Expr::Logical { left, right, .. } => {
                expr(left) || expr(right)
            }
            Expr::Unary { op, operand, .. } => op == "~" || expr(operand),
            Expr::Call { args, .. } | Expr::Intrinsic { args, .. } => args.iter().any(expr),
            Expr::Closure { .. } => false,
            Expr::CallValue { callee, args, .. } => expr(callee) || args.iter().any(expr),
            Expr::RecordLit { fields, .. } => fields.iter().any(|f| expr(&f.value)),
            Expr::Sequence { stmts, result, .. } => body(stmts) || expr(result),
            Expr::RecordGet { obj: value, .. }
            | Expr::UnionWrap { value, .. }
            | Expr::UnionNarrow { value, .. }
            | Expr::UnionIsTag { value, .. } => expr(value),
            Expr::Ternary {
                cond, then, else_, ..
            } => expr(cond) || expr(then) || expr(else_),
            _ => false,
        }
    }
    fn body(stmts: &[Stmt]) -> bool {
        stmts.iter().any(|stmt| match stmt {
            Stmt::Break { .. } | Stmt::Continue { .. } => false,
            Stmt::FieldSet { .. }
            | Stmt::Switch { .. }
            | Stmt::Throw { .. }
            | Stmt::TryCatch { .. }
            | Stmt::ArraySetLength { .. }
            | Stmt::ArraySet { .. }
            | Stmt::BytesSet { .. } => true,
            Stmt::RecordKeySet {
                obj, key, value, ..
            } => expr(obj) || expr(key) || expr(value),
            Stmt::RecordSet { obj, value, .. } => expr(obj) || expr(value),
            Stmt::VarDecl { init, .. } => expr(init),
            Stmt::Assign { value, .. } => expr(value),
            Stmt::Expression { expr: value, .. } => expr(value),
            Stmt::Return { value, .. } => value.as_ref().is_some_and(expr),
            Stmt::Block { body: stmts, .. } => body(stmts),
            Stmt::GeneratorForOf {
                generator,
                body: stmts,
                ..
            } => expr(generator) || body(stmts),
            Stmt::While {
                cond, body: stmts, ..
            } => expr(cond) || body(stmts),
            Stmt::If {
                cond, then, else_, ..
            } => expr(cond) || body(then) || else_.as_ref().is_some_and(|other| body(other)),
        })
    }
    fn ty(t: &Type) -> bool {
        match t {
            Type::Array { .. }
            | Type::Map { .. }
            | Type::Set { .. }
            | Type::Record { .. }
            | Type::Union { .. }
            | Type::Generator { .. }
            | Type::Object { .. } => true,
            Type::String
            | Type::Regex
            | Type::Stats
            | Type::Symbol
            | Type::Bytes { .. }
            | Type::Dyn
            | Type::Promise { .. } => true,
            Type::Func { params, ret, .. } => params.iter().any(ty) || ty(ret),
            _ => false,
        }
    }
    module.functions.len() > 1
        || !module.classes.is_empty()
        || !module.globals.is_empty()
        || !module.records.is_empty()
        || !module.unions.is_empty()
        || module
            .records
            .iter()
            .any(|r| r.fields.iter().any(|f| ty(&f.r#type)))
        || module.unions.iter().any(|u| u.arms.iter().any(ty))
        || module.functions.iter().any(|f| {
            ty(&f.return_type)
                || f.params.iter().any(|p| ty(&p.r#type))
                || f.locals.iter().any(|local| ty(&local.r#type))
                || body(&f.body)
        })
}

fn needs_full_lifecycle(module: &Module) -> bool {
    if module.functions.iter().any(|function| function.is_async) {
        return true;
    }
    let mut required = false;
    module.visit_expressions(&mut |value| {
        required |= match value {
            Expr::LibCall { .. }
            | Expr::DynInvoke { .. }
            | Expr::DynCall { .. }
            | Expr::CallValue { .. }
            | Expr::NewValue { .. } => true,
            Expr::Intrinsic { name, .. } => {
                name.starts_with("promise.") || name.starts_with("module.import.")
            }
            _ => false,
        };
    });
    required
}

fn lazy_class_capture<'a>(function: &'a Function, id: &str) -> Option<&'a Expr> {
    // Async and generator frames currently store these locals directly.
    if function.is_async || function.generator.is_some() {
        return None;
    }
    if !matches!(function.body.first(), Some(Stmt::VarDecl { init: Expr::LibCall { r#fn, .. }, .. }) if r#fn == "class.capture")
    {
        return None;
    }
    if !function
        .locals
        .iter()
        .any(|local| local.id == id && !local.boxed && !local.mutable)
    {
        return None;
    }
    function.body.iter().take_while(|statement| matches!(statement, Stmt::VarDecl { init: Expr::LibCall { r#fn, .. }, .. } if r#fn == "class.capture")).find_map(|statement| match statement {
        Stmt::VarDecl { local_id, init: init @ Expr::LibCall { r#fn, .. }, .. }
            if local_id == id && r#fn == "class.capture" => Some(init),
        _ => None,
    })
}

fn expr(value: &Expr, function: &Function, module: &Emission<'_>) -> String {
    if let Some(value) = exceptions::expression(value, function, module) {
        return value;
    }
    if let Some(code) = process::expression(value, function, module) {
        return code;
    }
    if let Some(code) = json_functions::expression(value, function, module) {
        return code;
    }
    if let Some(code) = child_process::expression(value, function, module) {
        return code;
    }
    if let Some(code) = filesystem_values::expression(value, function, module) {
        return code;
    }
    if let Some(code) = network::expression(value, function, module) {
        return code;
    }
    if let Some(code) = sets::expression(value, function, module) {
        return code;
    }
    if let Some(code) = values::promise_expression(value, function, module) {
        return code;
    }
    if let Some(code) = bigint::expression(value, function, module) {
        return code;
    }
    if let Some(code) = symbols::expression(value, function, module) {
        return code;
    }
    if let Some(code) = regex::expression(value, function, module) {
        return code;
    }
    if let Some(code) = classes::expression(value, function, module) {
        return code;
    }
    if let Some(code) = collections::expression(value, function, module) {
        return code;
    }
    if let Some(code) = generators::expression(value, function, module) {
        return code;
    }
    if let Some(code) = bytes::expression(value, function, module) {
        return code;
    }
    if let Some(code) = weak_maps::expression(value, function, module) {
        return code;
    }
    if let Some(code) = async_context::expression(value, function, module) {
        return code;
    }
    if let Some(code) = values::expression(value, function, module) {
        return code;
    }
    match value {
        Expr::Yield { .. }
        | Expr::YieldStar { .. }
        | Expr::GeneratorNext { .. }
        | Expr::GeneratorReturn { .. } => {
            unreachable!(
                "yield must be lowered to generator continuations before emission: {} at {:?}",
                function.name, function.loc
            )
        }
        Expr::Await { value, r#type, .. } => {
            let awaited = format!(
                "runtime::promise_block(&({}))",
                expr(value, function, module)
            );
            values::checked_value(r#type, &awaited, module)
        }
        Expr::CaughtToDyn { .. }
        | Expr::CaughtNarrow { .. }
        | Expr::CaughtTest { .. }
        | Expr::DynFrom { .. }
        | Expr::DynCheck { .. }
        | Expr::DynIterN { .. }
        | Expr::DynObjLit { .. }
        | Expr::DynArrLit { .. }
        | Expr::DynKeyGet { .. }
        | Expr::DynTest { .. }
        | Expr::DynScalarEq { .. }
        | Expr::DynLooseEq { .. }
        | Expr::DynInvoke { .. }
        | Expr::DynCall { .. } => unreachable!("native value expression"),
        Expr::BytesNew { .. } | Expr::BytesIntrinsic { .. } => unreachable!("bytes expression"),
        Expr::RegexLit { .. } | Expr::RegexIntrinsic { .. } => unreachable!("regex expression"),
        Expr::ClassRef { .. }
        | Expr::ClassCreate { .. }
        | Expr::NewValue { .. }
        | Expr::New { .. }
        | Expr::FieldGet { .. }
        | Expr::Upcast { .. }
        | Expr::Downcast { .. }
        | Expr::InstanceOf { .. }
        | Expr::VirtualCall { .. } => unreachable!("class expression"),
        Expr::ArrayGet { .. }
        | Expr::MapNew { .. }
        | Expr::MapIntrinsic { .. }
        | Expr::RecordKeyGet { .. }
        | Expr::ArrayIntrinsic { .. } => unreachable!("collection expression"),
        Expr::SetNew { .. } | Expr::SetIntrinsic { .. } => unreachable!("Set expression"),
        Expr::Closure {
            fn_name,
            captures,
            r#type,
            ..
        } => functions::closure(fn_name, captures, r#type, module),
        Expr::CallValue { callee, args, .. } => {
            receivers::call(callee, args, None, function, module)
        }
        Expr::Logical {
            op, left, right, ..
        } => format!(
            "({} {op} {})",
            expr(left, function, module),
            expr(right, function, module)
        ),
        Expr::StrEq {
            negated,
            left,
            right,
            ..
        } => format!(
            "({} {} {})",
            expr(left, function, module),
            if *negated { "!=" } else { "==" },
            expr(right, function, module)
        ),
        Expr::UnionEq {
            left,
            right,
            negated,
            ..
        } => {
            let Type::Union { union_id } = left.ty() else {
                unreachable!("IR validated");
            };
            format!(
                "{}union_eq_{union_id}({}, {})",
                if *negated { "!" } else { "" },
                expr(left, function, module),
                expr(right, function, module)
            )
        }
        Expr::StrConcat { left, right, .. } => {
            if let Expr::StrLit { value, .. } = left.as_ref()
                && let Expr::ToString { operand, .. } = right.as_ref()
                && operand.ty() == Type::F64
            {
                format!(
                    "js_string_concat_number({value:?}, {})",
                    expr(operand, function, module)
                )
            } else {
                format!(
                    "{{ let left = {}; let right = {}; runtime::string_concat(&left, &right) }}",
                    expr(left, function, module),
                    expr(right, function, module)
                )
            }
        }
        Expr::ToString { operand, .. } => {
            let value = expr(operand, function, module);
            match operand.ty() {
                Type::F64 => format!("runtime::JsString::from(js_string_number({value}))"),
                Type::Bool => format!("runtime::JsString::from(({value}).to_string())"),
                Type::Dyn => format!("native_value_string({value})"),
                _ => unreachable!("IR validated"),
            }
        }
        Expr::UnitLit { .. } => "()".into(),
        Expr::Sequence { stmts, result, .. } => {
            let mut output = String::from("{\n");
            for stmt in stmts {
                statement_in(stmt, function, module, &mut output, false);
            }
            output.push_str(&expr(result, function, module));
            output.push('}');
            output
        }
        Expr::RecordLit {
            fields,
            null_prototype,
            r#type: Type::Record { shape_id },
            ..
        } => {
            if module.records[*shape_id].index_value.is_some()
                && !record_storage::shared(&module.records[*shape_id], module)
            {
                let entries = fields
                    .iter()
                    .map(|f| {
                        format!(
                            "{{ let value = {}; js_dict_set(&mut entries, {:?}.into(), value); }}",
                            expr(&f.value, function, module),
                            f.name
                        )
                    })
                    .collect::<String>();
                return format!(
                    "{{ let mut entries = Vec::new(); {entries} runtime::Gc::new(R{shape_id} {{ overflow: entries }}) }}"
                );
            }
            if record_storage::shared(&module.records[*shape_id], module) {
                if let Some(call) = fields.iter().find(|field| field.name == "\0scriptc.call") {
                    let function_value = expr(&call.value, function, module);
                    let function_box =
                        values::box_value(&call.value.ty(), "function_value", module);
                    let properties = fields
                        .iter()
                        .filter(|field| field.name != "\0scriptc.call")
                        .map(|field| {
                            let value = expr(&field.value, function, module);
                            if field.absent {
                                format!("let _ = {value};")
                            } else {
                                format!(
                                    "{{ let value = {value}; native_record_set(&data, {:?}.into(), {}); }}",
                                    field.name,
                                    values::box_value(&field.value.ty(), "value", module)
                                )
                            }
                        })
                        .collect::<String>();
                    let tags = crate::ir::record_equivalence::record_representatives(
                        &module.records,
                        &module.unions,
                    );
                    return format!(
                        "{{ let function_value = {function_value}; let function = {function_box}; let data = native_function_properties(&function).expect(\"validated callable record function\"); {properties} native_callable_attach(data, function, {}) }}",
                        tags[*shape_id]
                    );
                }
                let entries = fields.iter().map(|f| {
                    let value = expr(&f.value, function, module);
                    if f.absent { format!("let _ = {value};") } else {
                        format!("{{ let value = {value}; native_record_define(&mut entries, {:?}.into(), {}); }}", f.name, values::box_value(&f.value.ty(), "value", module))
                    }
                }).collect::<String>();
                return format!(
                    "{{ let mut entries = Vec::new(); {entries} runtime::Gc::new(NativeRecordData {{ null_prototype: {null_prototype}, symbol_properties: None, entries, hash_index: NativeHashIndex::default() }}) }}"
                );
            }
            let keys = fields
                .iter()
                .filter(|f| !f.absent)
                .map(|f| format!("{:?}.into()", f.name))
                .collect::<Vec<_>>()
                .join(", ");
            let fields = fields
                .iter()
                .map(|f| {
                    format!(
                        "{}: Some({})",
                        field_name(&f.name),
                        expr(&f.value, function, module)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let source = module.records[*shape_id]
                .tuple
                .then_some("source: None, ")
                .unwrap_or("");
            format!("runtime::Gc::new(R{shape_id} {{ {source}own_keys: vec![{keys}], {fields} }})")
        }
        Expr::RecordLit { .. } => unreachable!("IR validated"),
        Expr::RecordGet {
            obj, field, r#type, ..
        } => {
            let Type::Record { shape_id } = obj.ty() else {
                unreachable!("IR validated")
            };
            if record_storage::shared(&module.records[shape_id], module) {
                record_storage::read(
                    r#type,
                    &expr(obj, function, module),
                    shape_id,
                    field,
                    module,
                )
            } else if module.records[shape_id].tuple {
                let index = module.records[shape_id]
                    .fields
                    .iter()
                    .position(|candidate| candidate.name == *field)
                    .expect("validated tuple field");
                let checked = values::checked_value(r#type, "raw", module);
                format!(
                    "{{ let object = {}; if let Some(source) = object.with(|object| object.source.clone()) {{ let raw = runtime::array_get(&source, {index}.0); {checked} }} else {{ object.with(|object| object.{}.as_ref().expect(\"scriptc: cleared record\").clone()) }} }}",
                    expr(obj, function, module),
                    field_name(field)
                )
            } else {
                format!(
                    "{{ let object = {}; let value = object.with(|object| object.{}.as_ref().expect(\"scriptc: cleared record\").clone()); value }}",
                    expr(obj, function, module),
                    field_name(field)
                )
            }
        }
        Expr::UnionWrap {
            tag,
            value,
            r#type: Type::Union { union_id },
            ..
        } => format!("U{union_id}::V{tag}({})", expr(value, function, module)),
        Expr::UnionWrap { .. } => unreachable!("IR validated"),
        Expr::UnionNarrow {
            tag, value, r#type, ..
        } => {
            let Type::Union { union_id } = value.ty() else {
                unreachable!("IR validated");
            };
            if let Type::Record { shape_id } = r#type
                && record_storage::shared(&module.records[*shape_id], module)
            {
                // Shared record arms are views of the same object. A runtime
                // guard can narrow an overlapping shape even when the array
                // entered this union through another compatible view.
                let arms = module.unions[union_id]
                    .arms
                    .iter()
                    .enumerate()
                    .filter_map(|(index, arm)| {
                        if let Type::Record { shape_id } = arm
                            && record_storage::shared(&module.records[*shape_id], module)
                        {
                            Some(format!("U{union_id}::V{index}(value)"))
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" | ");
                if !arms.is_empty() {
                    return format!(
                        "match {} {{ {arms} => value, _ => panic!(\"invalid narrowed union tag\") }}",
                        expr(value, function, module)
                    );
                }
            }
            format!(
                "match {} {{ U{union_id}::V{tag}(value) => value, _ => panic!(\"invalid narrowed union tag\") }}",
                expr(value, function, module)
            )
        }
        Expr::UnionProject { value, r#type, .. } => {
            let Type::Union { union_id: source } = value.ty() else {
                unreachable!("IR validated");
            };
            let Type::Union { union_id: target } = r#type else {
                unreachable!("IR validated");
            };
            let cases = module.unions[source]
                .arms
                .iter()
                .enumerate()
                .map(|(source_tag, arm)| {
                    module.unions[*target]
                        .arms
                        .iter()
                        .position(|target_arm| target_arm == arm)
                        .map_or_else(
                            || format!("U{source}::V{source_tag}(..) => panic!(\"invalid narrowed union tag\")"),
                            |target_tag| format!("U{source}::V{source_tag}(value) => U{target}::V{target_tag}(value)"),
                        )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("match {} {{ {cases} }}", expr(value, function, module))
        }
        Expr::UnionIsTag {
            tag,
            negated,
            value,
            ..
        } => {
            let Type::Union { union_id } = value.ty() else {
                unreachable!("IR validated");
            };
            format!(
                "{}matches!({}, U{union_id}::V{tag}(_))",
                if *negated { "!" } else { "" },
                expr(value, function, module)
            )
        }
        Expr::Ternary {
            cond, then, else_, ..
        } => format!(
            "(if {} {{ {} }} else {{ {} }})",
            expr(cond, function, module),
            expr(then, function, module),
            expr(else_, function, module)
        ),
        Expr::ArrayLit {
            elems,
            r#type: Type::Array { elem },
            ..
        } => {
            let values = elems
                .iter()
                .map(|value| {
                    if **elem == Type::String {
                        format!("runtime::JsString::from({})", expr(value, function, module))
                    } else {
                        expr(value, function, module)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let element = if **elem == Type::String {
                "runtime::JsString"
            } else {
                &rust_type((**elem).clone(), module)
            };
            format!("runtime::array_new::<{element}>(vec![{values}])")
        }
        Expr::ArrayLit { .. } => unreachable!("IR validated"),
        Expr::StringIntrinsic {
            method,
            receiver,
            args,
            ..
        } => {
            let runtime = if method == "split" {
                "string_split"
            } else if method == "encodeURIComponent" {
                "string_encode_uri_component"
            } else if method == "encodeURI" {
                "string_encode_uri"
            } else if method == "decodeURIComponent" {
                "string_decode_uri_component"
            } else if method == "decodeURI" {
                "string_decode_uri"
            } else if method == "unescape" {
                "string_unescape"
            } else if method == "atob" {
                "string_atob"
            } else if method == "btoa" {
                "string_btoa"
            } else {
                crate::string_builtins::by_method(method)
                    .expect("IR validated")
                    .runtime
            };
            let receiver = expr(receiver, function, module);
            let args = args
                .iter()
                .map(|arg| {
                    let value = expr(arg, function, module);
                    if arg.ty() == Type::String {
                        format!(", &({value})")
                    } else {
                        format!(", {value}")
                    }
                })
                .collect::<String>();
            format!("runtime::{runtime}(&({receiver}){args})")
        }
        Expr::LibCall { r#fn, .. } if r#fn == "dyn.this" => "native_this.clone()".into(),
        Expr::LibCall {
            r#fn,
            args,
            r#type: Type::Union { union_id },
            ..
        } if r#fn == "bun.which" => {
            let string = module.unions[*union_id]
                .arms
                .iter()
                .position(|arm| *arm == Type::String)
                .expect("validated Bun.which string arm");
            let null = module.unions[*union_id]
                .arms
                .iter()
                .position(|arm| *arm == Type::Null)
                .expect("validated Bun.which null arm");
            let optional_string = |value: &Expr| {
                if value.ty() == Type::Null {
                    "None".to_owned()
                } else {
                    format!("Some({})", expr(value, function, module))
                }
            };
            format!(
                "{{ let command = {}; let path = {}; let cwd = {}; match runtime::bun_which(&command, path.as_ref(), cwd.as_ref()) {{ Some(value) => U{union_id}::V{string}(value), None => U{union_id}::V{null}(()), }} }}",
                expr(&args[0], function, module),
                optional_string(&args[1]),
                optional_string(&args[2]),
            )
        }
        Expr::LibCall { r#fn, args, .. }
            if matches!(r#fn.as_str(), "timers.setTimeout" | "timers.setInterval") =>
        {
            let callback_type = args[0].ty();
            let runtime = if r#fn == "timers.setInterval" {
                "timer_set_interval"
            } else {
                "timer_set_timeout_handle"
            };
            format!(
                "{{ let callback = {}; runtime::{runtime}(Box::new(move || {{ call_{}(callback.clone()); }}), {}) }}",
                expr(&args[0], function, module),
                functions::type_name(&callback_type, module),
                expr(&args[1], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "array.toString" => {
            format!(
                "native_array_to_string({})",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "timers.setImmediate" => {
            let callback_type = args[0].ty();
            format!(
                "{{ let callback = {}; runtime::timer_set_immediate(Box::new(move || {{ call_{}(callback.clone()); }})) }}",
                expr(&args[0], function, module),
                functions::type_name(&callback_type, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "timers.clearImmediate" => format!(
            "runtime::timer_clear_immediate({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "timers.queueMicrotask" => {
            let callback_type = args[0].ty();
            format!(
                "{{ let callback = {}; runtime::timer_queue_microtask(Box::new(move || {{ call_{}(callback.clone()); }})) }}",
                expr(&args[0], function, module),
                functions::type_name(&callback_type, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "fs.cpSyncFiltered" => {
            let callback_type = args[4].ty();
            format!(
                "{{ let filter = {}; runtime::fs_cp_sync_filtered(&({}), &({}), {}, {}, |source, destination| call_{}(filter.clone(), source.clone(), destination.clone())) }}",
                expr(&args[4], function, module),
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module),
                expr(&args[3], function, module),
                functions::type_name(&callback_type, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "fs.mkdirPromise" => format!(
            "{{ let source = runtime::fs_mkdir_promise(&({}), {}, {}); runtime::promise_view_map(&source, |value| value.map(NativeValue::String).unwrap_or(NativeValue::Undefined)) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "fs.createWriteStreamPath" => format!(
            "native_file_write_stream_value({}, NativeValue::Undefined)",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "fs.createWriteStream" => format!(
            "native_file_write_stream_value({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "fs.openPromise" => format!(
            "{{ let source = runtime::file_handle_open_promise(&({}), &({}), f64::from_bits({}_u64)); runtime::promise_view_map(&source, native_file_handle_value) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            (0o666 as f64).to_bits(),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "fs.openNumericPromise" => format!(
            "{{ let source = runtime::file_handle_open_numeric_promise(&({}), {}, {}); runtime::promise_view_map(&source, native_file_handle_value) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dns.lookupPromisified" => format!(
            "native_dns_lookup_promisified({})",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. }
            if matches!(r#fn.as_str(), "dns.lookup" | "dns.lookupDefault") =>
        {
            let (options, callback) = if args.len() == 2 {
                (
                    "NativeValue::Undefined".to_owned(),
                    expr(&args[1], function, module),
                )
            } else {
                (
                    expr(&args[1], function, module),
                    expr(&args[2], function, module),
                )
            };
            format!(
                "native_dns_lookup_callback({}, {options}, {callback})",
                expr(&args[0], function, module),
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "diagnostics.channel" => format!(
            "NativeValue::DiagnosticsChannel(runtime::diagnostics_channel::<NativeValue>(&({})))",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "diagnostics.subscribe" => format!(
            "{{ let name = {}; let callback = {}; let identity = native_function_properties(&callback).unwrap_or_else(|| runtime::throw_type_error(\"diagnostics_channel subscriber must be a function\".into())).identity(); runtime::diagnostics_subscribe(&name, identity, callback) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "diagnostics.unsubscribe" => format!(
            "{{ let name = {}; let callback = {}; let identity = native_function_properties(&callback).unwrap_or_else(|| runtime::throw_type_error(\"diagnostics_channel subscriber must be a function\".into())).identity(); runtime::diagnostics_unsubscribe::<NativeValue>(&name, identity) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "diagnostics.hasSubscribers" => format!(
            "runtime::diagnostics_has_subscribers::<NativeValue>(&({}))",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "util.debuglog" => format!(
            "native_debuglog_value({})",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "util.inspect" => format!(
            "runtime::JsString::from(native_util_inspect({}))",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "util.formatWithOptionsValue" => format!(
            "{{ let _options = {}; runtime::JsString::from(native_util_format_value({})) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "querystring.stringify" => format!(
            "runtime::querystring_stringify(&({}), &runtime::string(\"&\"), &runtime::string(\"=\"))",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. }
            if r#fn == "http.incomingMessageConstructor" && args.is_empty() =>
        {
            "NativeValue::HttpIncomingMessageConstructor".into()
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "dns.resolveMx" => format!(
            "native_dns_resolve_mx({})",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "dns.resolveTxt" => format!(
            "native_dns_resolve_txt({})",
            expr(&args[0], function, module),
        ),
        Expr::LibCall { r#fn, args, .. }
            if matches!(r#fn.as_str(), "dns.resolve4Options" | "dns.resolve6Options") =>
        {
            let record_type = if r#fn == "dns.resolve4Options" { 1 } else { 28 };
            format!(
                "{{ let options = {}; let ttl = native_dns_ttl_option(options); native_dns_resolve_record({}, {record_type}, ttl, false) }}",
                expr(&args[1], function, module),
                expr(&args[0], function, module),
            )
        }
        Expr::LibCall { r#fn, args, .. }
            if matches!(
                r#fn.as_str(),
                "dns.resolve4"
                    | "dns.resolve6"
                    | "dns.resolveCaa"
                    | "dns.resolveCname"
                    | "dns.resolveNaptr"
                    | "dns.resolveNs"
                    | "dns.resolvePtr"
                    | "dns.resolveSoa"
                    | "dns.resolveSrv"
                    | "dns.reverse"
            ) =>
        {
            let (record_type, reverse) = match r#fn.as_str() {
                "dns.resolve4" => (1, false),
                "dns.resolve6" => (28, false),
                "dns.resolveCaa" => (257, false),
                "dns.resolveCname" => (5, false),
                "dns.resolveNaptr" => (35, false),
                "dns.resolveNs" => (2, false),
                "dns.resolvePtr" => (12, false),
                "dns.resolveSoa" => (6, false),
                "dns.resolveSrv" => (33, false),
                "dns.reverse" => (12, true),
                _ => unreachable!(),
            };
            format!(
                "native_dns_resolve_record({}, {record_type}, false, {reverse})",
                expr(&args[0], function, module),
            )
        }
        Expr::LibCall { r#fn, args, .. }
            if matches!(
                r#fn.as_str(),
                "timers.clearTimeout" | "timers.clearInterval"
            ) =>
        {
            format!("runtime::timer_clear({})", expr(&args[0], function, module))
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "timers.methodValue" => {
            let Expr::StrLit { value: method, .. } = &args[1] else {
                unreachable!("validated timer method")
            };
            let id = match method.as_str() {
                "refresh" => 0,
                "unref" => 1,
                "ref" => 2,
                "hasRef" => 3,
                _ => unreachable!(),
            };
            format!(
                "{{ let _handle = {}; NativeValue::TimerMethod({id}) }}",
                expr(&args[0], function, module)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "timers.setRef" => format!(
            "runtime::timer_set_ref({}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "timers.hasRef" => format!(
            "runtime::timer_has_ref({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "timers.refresh" => format!(
            "runtime::timer_refresh({})",
            expr(&args[0], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } => {
            let builtin = crate::builtins::by_ir(r#fn).expect("IR validated");
            if let crate::builtins::Implementation::FloatBinaryMethod(name) = builtin.implementation
            {
                return format!(
                    "{{ let left = {}; let right = {}; left.{name}(right) }}",
                    expr(&args[0], function, module),
                    expr(&args[1], function, module)
                );
            }
            let args = args
                .iter()
                .map(|arg| match arg.ty() {
                    Type::String => {
                        format!("&runtime::JsString::from({})", expr(arg, function, module))
                    }
                    Type::Array { .. }
                    | Type::Bytes { .. }
                    | Type::CryptoHash
                    | Type::CryptoSign
                    | Type::Stats
                    | Type::Dirent => {
                        format!("&({})", expr(arg, function, module))
                    }
                    _ => expr(arg, function, module),
                })
                .collect::<Vec<_>>()
                .join(", ");
            match builtin.implementation {
                crate::builtins::Implementation::Runtime(name) => {
                    let call = format!("runtime::{name}({args})");
                    if let Type::Promise { inner } = &builtin.result {
                        if **inner == Type::Void {
                            format!(
                                "{{ let source = {call}; runtime::promise_view_map(&source, |_| NativeValue::Undefined) }}"
                            )
                        } else if **inner != Type::Dyn {
                            let boxed = values::box_value(inner, "value", module);
                            format!(
                                "{{ let source = {call}; runtime::promise_view_map(&source, |value| {boxed}) }}"
                            )
                        } else {
                            call
                        }
                    } else {
                        call
                    }
                }
                crate::builtins::Implementation::NativeHelper(name) => format!("{name}({args})"),
                crate::builtins::Implementation::Emitter(name) => {
                    unreachable!("{name} emitter operation was not intercepted")
                }
                crate::builtins::Implementation::FloatMethod(name) => format!("({args}).{name}()"),
                crate::builtins::Implementation::FloatBinaryMethod(_) => unreachable!(),
            }
        }
        Expr::NumLit { value, .. } => format!("f64::from_bits({}_u64)", value.to_bits()),
        Expr::StrLit { value, .. } => format!("runtime::JsString::from({value:?})"),
        Expr::BoolLit { value, .. } => value.to_string(),
        Expr::VarRef {
            local_id, r#type, ..
        } => {
            if classes::lazy_constructor_capture(function, local_id, module) {
                return values::checked_value(
                    r#type,
                    &format!("native_class_capture_value(&{local_id})"),
                    module,
                );
            }
            if let Some(capture) = lazy_class_capture(function, local_id) {
                return expr(capture, function, module);
            }
            if let Some(global) = module.global(local_id) {
                return storage::read(module, global);
            }
            if function.locals.iter().any(|l| l.id == *local_id && l.boxed) {
                return format!("native_cell_read(&{local_id})");
            }
            if matches!(
                r#type,
                Type::String
                    | Type::Dyn
                    | Type::Caught
                    | Type::Array { .. }
                    | Type::Map { .. }
                    | Type::Set { .. }
                    | Type::Record { .. }
                    | Type::Union { .. }
                    | Type::Func { .. }
                    | Type::Object { .. }
                    | Type::Regex
                    | Type::CryptoHash
                    | Type::CryptoSign
                    | Type::Bytes { .. }
                    | Type::Bigint
                    | Type::Symbol
                    | Type::Promise { .. }
                    | Type::Generator { .. }
                    | Type::Child
                    | Type::Stats
            ) {
                format!("{local_id}.clone()")
            } else {
                local_id.clone()
            }
        }
        Expr::Bin {
            op, left, right, ..
        } => {
            let is_array = matches!(left.ty(), Type::Array { .. });
            let array = matches!(
                left.ty(),
                Type::Array { .. }
                    | Type::Record { .. }
                    | Type::Map { .. }
                    | Type::Set { .. }
                    | Type::Object { .. }
                    | Type::Func { .. }
                    | Type::Bytes { .. }
                    | Type::CryptoSign
                    | Type::Child
                    | Type::Stats
            );
            let record = matches!(left.ty(), Type::Regex);
            let promise = matches!(left.ty(), Type::Promise { .. });
            let function_type = if matches!(left.ty(), Type::Func { .. }) {
                Some(left.ty())
            } else {
                None
            };
            let left = expr(left, function, module);
            let right = expr(right, function, module);
            match op.as_str() {
                "===" | "!==" if function_type.is_some() => {
                    let name = functions::type_name(function_type.as_ref().unwrap(), module);
                    format!(
                        "{}properties_{name}(&({left})).ptr_eq(&properties_{name}(&({right})))",
                        if op == "!==" { "!" } else { "" }
                    )
                }
                "===" | "!==" if promise => format!(
                    "(runtime::promise_view_identity(&({left})) {} runtime::promise_view_identity(&({right})))",
                    if op == "!==" { "!=" } else { "==" }
                ),
                "===" | "!==" if is_array => format!(
                    "(runtime::array_identity(&({left})) {} runtime::array_identity(&({right})))",
                    if op == "!==" { "!=" } else { "==" }
                ),
                "===" | "!==" if array => format!(
                    "{}({left}).ptr_eq(&({right}))",
                    if op == "!==" { "!" } else { "" }
                ),
                "===" | "!==" if record => format!(
                    "{}std::rc::Rc::ptr_eq(&({left}), &({right}))",
                    if op == "!==" { "!" } else { "" }
                ),
                "===" => format!("({left} == {right})"),
                "!==" => format!("({left} != {right})"),
                "**" => format!("js_pow({left}, {right})"),
                "&" => format!("runtime::bit_and({left}, {right})"),
                "|" => format!("runtime::bit_or({left}, {right})"),
                "^" => format!("runtime::bit_xor({left}, {right})"),
                "<<" => format!("runtime::shift_left({left}, {right})"),
                ">>" => format!("runtime::shift_right({left}, {right})"),
                ">>>" => format!("runtime::shift_right_unsigned({left}, {right})"),
                _ => format!("({left} {op} {right})"),
            }
        }
        Expr::Unary { op, operand, .. } if op == "~" => {
            format!("runtime::bit_not({})", expr(operand, function, module))
        }
        Expr::Unary { op, operand, .. } => format!("({op}({}))", expr(operand, function, module)),
        Expr::Call { callee, args, .. }
            if callee.starts_with("%lazy_module_") && args.is_empty() =>
        {
            let index = module
                .functions
                .iter()
                .position(|function| &function.name == callee)
                .expect("validated lazy module call");
            format!("native_module_eval_{index}()")
        }
        Expr::Call { callee, args, .. } => format!(
            "{}({})",
            function_name(callee),
            module
                .functions
                .iter()
                .find(|f| &f.name == callee)
                .filter(|f| f.reads_receiver())
                .map(|_| "NativeValue::Undefined".into())
                .into_iter()
                .chain(args.iter().enumerate().map(|(index, value)| {
                    let emitted = expr(value, function, module);
                    let parameter = module
                        .functions
                        .iter()
                        .find(|target| &target.name == callee)
                        .and_then(|target| target.params.get(index).map(|param| (target, param)));
                    if parameter.is_some_and(|(target, param)| {
                        classes::lazy_constructor_capture(target, &param.local_id, module)
                    }) {
                        format!(
                            "NativeClassCapture::Value({})",
                            values::box_value(&value.ty(), &emitted, module)
                        )
                    } else {
                        emitted
                    }
                }))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expr::Intrinsic { name, args, .. } => {
            if name == "function.call.value" {
                return "NativeValue::FunctionCall".into();
            }
            if name == "function.hasInstance.value" {
                return "NativeValue::FunctionHasInstance".into();
            }
            if name == "caught.toString" {
                return format!(
                    "native_exception_value_string(&{})",
                    expr(&args[0], function, module)
                );
            }
            if name == "console.dir" {
                return format!(
                    "console(false, &[native_value_inspect({})])",
                    expr(&args[0], function, module)
                );
            }
            if matches!(name.as_str(), "console.log.spread" | "console.error.spread") {
                return format!(
                    "{{ let raw = runtime::array_values(&({})); let formatted = matches!(raw.first(), Some(NativeValue::String(_))); let values = raw.into_iter().map(native_value_inspect).collect::<Vec<_>>(); if formatted {{ console_format({}, &values) }} else {{ console({}, &values) }} }}",
                    expr(&args[0], function, module),
                    name == "console.error.spread",
                    name == "console.error.spread",
                );
            }
            let args = args
                .iter()
                .map(|arg| match arg.ty() {
                    Type::F64 => format!("js_number({})", expr(arg, function, module)),
                    Type::Bool => format!("({}).to_string()", expr(arg, function, module)),
                    Type::String => format!(
                        "({}).to_utf8_lossy().to_owned()",
                        expr(arg, function, module)
                    ),
                    Type::Dyn => format!("native_value_inspect({})", expr(arg, function, module)),
                    Type::Void => unreachable!("IR validated"),
                    _ => unreachable!("IR validated"),
                })
                .collect::<Vec<_>>()
                .join(", ");
            if name.ends_with(".format") {
                format!(
                    "console_format({}, &[{args}])",
                    name.starts_with("console.error")
                )
            } else {
                format!("console({}, &[{args}])", name == "console.error")
            }
        }
    }
}

fn statement(stmt: &Stmt, function: &Function, module: &Emission<'_>, output: &mut String) {
    statement_in(stmt, function, module, output, false);
}
fn statement_in(
    stmt: &Stmt,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    protected: bool,
) {
    statement_with_flow(
        stmt,
        function,
        module,
        output,
        &FlowContext {
            region: usize::from(protected),
            targets: vec![],
        },
    );
}

#[derive(Clone, Default)]
struct FlowContext {
    region: usize,
    targets: Vec<JumpTarget>,
}
#[derive(Clone)]
struct JumpTarget {
    region: usize,
    allows_continue: bool,
    iterator_close: Option<String>,
}

fn iterator_closes(output: &mut String, targets: &[JumpTarget], region: usize, start: usize) {
    use std::fmt::Write;
    for target in targets[start..]
        .iter()
        .rev()
        .filter(|target| target.region == region)
    {
        if let Some(generator) = &target.iterator_close {
            writeln!(
                output,
                "let _ = runtime::generator_return(&{generator}, None);"
            )
            .unwrap();
        }
    }
}

fn statement_with_flow(
    stmt: &Stmt,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    flow: &FlowContext,
) {
    use std::fmt::Write;
    let protected = flow.region != 0;
    match stmt {
        Stmt::GeneratorForOf {
            generator,
            local_id,
            body,
            ..
        } => {
            let Type::Generator { next_type, .. } = generator.ty() else {
                unreachable!("IR validated generator for-of type")
            };
            let initial = if *next_type == Type::Dyn {
                "NativeValue::Undefined"
            } else {
                "()"
            };
            let id = flow.targets.len();
            let local = function
                .locals
                .iter()
                .find(|local| local.id == *local_id)
                .expect("IR validated");
            let local_type = rust_type(local.r#type.clone(), module);
            let binding = if local.boxed {
                format!(
                    "let {local_id}: runtime::Gc<NativeCell<{local_type}>> = native_cell(value);"
                )
            } else {
                let mutable = if local.mutable { "mut " } else { "" };
                format!("let {mutable}{local_id}: {local_type} = value;")
            };
            writeln!(
                output,
                "{{ let native_generator_{id} = {}; 'native_loop_{id}: loop {{ match runtime::generator_next_without_arg(&native_generator_{id}, {initial}) {{ runtime::GeneratorStep::Yielded(value) => {{ {binding}",
                expr(generator, function, module),
            )
            .unwrap();
            let mut inner = flow.clone();
            inner.targets.push(JumpTarget {
                region: flow.region,
                allows_continue: true,
                iterator_close: Some(format!("native_generator_{id}")),
            });
            // A call, property read, or any other body expression can throw.
            // Capture that completion before closing so a throwing `return`
            // cannot replace an already pending JavaScript exception.
            output.push_str("let native_iteration_completion = ");
            exceptions::region(body, function, module, output, &inner);
            writeln!(output, "; match native_iteration_completion {{ runtime::Completion::Normal => {{}}, runtime::Completion::Throw(caught) => {{ let close = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime::generator_return(&native_generator_{id}, None))); if let Err(payload) = close {{ let _ = runtime::caught_from_panic(payload); }} runtime::rethrow_caught(caught); }},").unwrap();
            output.push_str("runtime::Completion::Return(value) => {\n");
            iterator_closes(output, &inner.targets, flow.region, 0);
            if flow.region != 0 {
                output.push_str("return runtime::Completion::Return(value); },\n");
            } else {
                output.push_str("return value; },\n");
            }
            for (target_id, target) in inner.targets.iter().enumerate() {
                writeln!(output, "runtime::Completion::Break({target_id}) => {{").unwrap();
                iterator_closes(output, &inner.targets, flow.region, target_id);
                if target.region == flow.region {
                    writeln!(output, "break 'native_loop_{target_id}; }},").unwrap();
                } else {
                    writeln!(
                        output,
                        "return runtime::Completion::Break({target_id}); }},"
                    )
                    .unwrap();
                }
                if target.allows_continue {
                    writeln!(output, "runtime::Completion::Continue({target_id}) => {{").unwrap();
                    iterator_closes(output, &inner.targets, flow.region, target_id + 1);
                    if target.region == flow.region {
                        writeln!(output, "continue 'native_loop_{target_id}; }},").unwrap();
                    } else {
                        writeln!(
                            output,
                            "return runtime::Completion::Continue({target_id}); }},"
                        )
                        .unwrap();
                    }
                }
            }
            if flow.region != 0 {
                output.push_str("completion => return completion, }\n");
            } else {
                output.push_str("_ => unreachable!(\"validated iteration completion\"), }\n");
            }
            writeln!(
                output,
                "}}, runtime::GeneratorStep::Returned(_) => break 'native_loop_{id}, }} }} }}"
            )
            .unwrap();
        }
        Stmt::Switch { disc, cases, .. } => {
            let id = flow.targets.len();
            writeln!(output, "{{ let native_switch_disc = {}; let mut native_switch_start = {}usize; let mut native_switch_matched = false;", expr(disc, function, module), cases.len()).unwrap();
            for (index, case) in cases.iter().enumerate() {
                if let Some(test) = &case.test {
                    writeln!(output, "if !native_switch_matched {{ let test = {}; if native_switch_disc == test {{ native_switch_start = {index}; native_switch_matched = true; }} }}", expr(test, function, module)).unwrap();
                }
            }
            if let Some(index) = cases.iter().position(|case| case.test.is_none()) {
                writeln!(
                    output,
                    "if !native_switch_matched {{ native_switch_start = {index}; }}"
                )
                .unwrap();
            }
            writeln!(output, "'native_loop_{id}: {{").unwrap();
            let mut inner = flow.clone();
            inner.targets.push(JumpTarget {
                region: flow.region,
                allows_continue: false,
                iterator_close: None,
            });
            for (index, case) in cases.iter().enumerate() {
                writeln!(output, "if native_switch_start <= {index} {{").unwrap();
                for statement in &case.body {
                    statement_with_flow(statement, function, module, output, &inner);
                }
                output.push_str("}\n");
            }
            output.push_str("}\n");
            if crate::ir::always_returns(std::slice::from_ref(stmt)) {
                output.push_str("unreachable!(\"validated switch completion\");\n");
            }
            output.push_str("}\n");
        }
        Stmt::Throw { value, .. } => {
            let closes = flow
                .targets
                .iter()
                .rev()
                .filter(|target| target.region == flow.region)
                .filter_map(|target| target.iterator_close.as_deref())
                .collect::<Vec<_>>();
            if !closes.is_empty() {
                writeln!(
                    output,
                    "{{ let native_thrown = {};",
                    values::box_value(&value.ty(), &expr(value, function, module), module)
                )
                .unwrap();
                for generator in closes {
                    writeln!(
                        output,
                        "let _ = runtime::generator_return(&{generator}, None);"
                    )
                    .unwrap();
                }
                output.push_str("runtime::throw_value(native_thrown); }\n");
                return;
            }
            writeln!(
                output,
                "runtime::throw_value({});",
                values::box_value(&value.ty(), &expr(value, function, module), module)
            )
            .unwrap();
        }
        Stmt::TryCatch { .. } => exceptions::statement(stmt, function, module, output, flow),
        Stmt::FieldSet {
            obj,
            class_name,
            field,
            value,
            ..
        } => {
            let index = module
                .classes
                .iter()
                .position(|c| c.name == *class_name)
                .unwrap();
            writeln!(
                output,
                "{{ let object = {}; let value = {}; instance_set_{index}_{}(object, value); }}",
                expr(obj, function, module),
                expr(value, function, module),
                field_name(field)
            )
            .unwrap();
        }
        Stmt::ArraySet {
            arr, index, value, ..
        } => {
            writeln!(output, "{{ let array = {}; let index = {}; let value = {}; runtime::array_set(&array, index, value); }}", expr(arr, function, module), expr(index, function, module), expr(value, function, module)).unwrap();
        }
        Stmt::BytesSet {
            arr, index, value, ..
        } => {
            writeln!(output, "{{ let bytes = {}; let index = {}; let value = {}; runtime::bytes_set(&bytes, index, value); }}", expr(arr, function, module), expr(index, function, module), expr(value, function, module)).unwrap();
        }
        Stmt::ArraySetLength { arr, length, .. } => {
            writeln!(
                output,
                "{{ let array = {}; let length = {}; runtime::array_set_length(&array, length); }}",
                expr(arr, function, module),
                expr(length, function, module)
            )
            .unwrap();
        }
        Stmt::RecordKeySet {
            obj, key, value, ..
        } => {
            let Type::Record { shape_id } = obj.ty() else {
                unreachable!("IR validated")
            };
            if record_storage::shared(&module.records[shape_id], module) {
                writeln!(output, "{{ let object = {}; let key = {}; let value = {}; native_record_set(&object, key, {}); }}", expr(obj, function, module), expr(key, function, module), expr(value, function, module), values::box_value(&value.ty(), "value", module)).unwrap();
            } else {
                writeln!(output, "{{ let object = {}; let key = {}; let value = {}; object.with_mut(|object| js_dict_set(&mut object.overflow, key, value)); }}", expr(obj, function, module), expr(key, function, module), expr(value, function, module)).unwrap();
            }
        }
        Stmt::RecordSet {
            obj, field, value, ..
        } => {
            let Type::Record { shape_id } = obj.ty() else {
                unreachable!("IR validated")
            };
            if record_storage::shared(&module.records[shape_id], module) {
                let slot = module.records[shape_id]
                    .declared_order
                    .iter()
                    .position(|name| name == field)
                    .or_else(|| {
                        module.records[shape_id]
                            .fields
                            .iter()
                            .position(|candidate| candidate.name == *field)
                    })
                    .expect("validated record field");
                writeln!(output, "{{ let object = {}; let value = {}; native_record_slot_set(&object, {slot}, {:?}.into(), {}); }}", expr(obj, function, module), expr(value, function, module), field, values::box_value(&value.ty(), "value", module)).unwrap();
                return;
            }
            if module.records[shape_id].tuple {
                let index = module.records[shape_id]
                    .fields
                    .iter()
                    .position(|candidate| candidate.name == *field)
                    .expect("validated tuple field");
                writeln!(
                    output,
                    "{{ let object = {}; let value = {}; if let Some(source) = object.with(|object| object.source.clone()) {{ runtime::array_set(&source, {index}.0, {}); }} else {{ object.with_mut(|object| {{ object.{} = Some(value); if !object.own_keys.iter().any(|key| key == {:?}) {{ object.own_keys.push({:?}.into()); }} }}); }} }}",
                    expr(obj, function, module),
                    expr(value, function, module),
                    values::box_value(&value.ty(), "value.clone()", module),
                    field_name(field), field, field
                )
                .unwrap();
                return;
            }
            writeln!(
                output,
                "{{ let object = {}; let value = {}; object.with_mut(|object| {{ object.{} = Some(value); if !object.own_keys.iter().any(|key| key == {:?}) {{ object.own_keys.push({:?}.into()); }} }}); }}",
                expr(obj, function, module),
                expr(value, function, module),
                field_name(field), field, field
            )
            .unwrap();
        }
        Stmt::VarDecl { local_id, init, .. } => {
            if lazy_class_capture(function, local_id).is_some() {
                return;
            }
            let local = function
                .locals
                .iter()
                .find(|local| local.id == *local_id)
                .expect("IR validated");
            let mutable = if local.mutable { "mut " } else { "" };
            let ty = rust_type(local.r#type.clone(), module);
            if local.boxed {
                if matches!(init, Expr::LibCall { r#fn, .. } if r#fn == "lexical.empty") {
                    writeln!(output, "let {local_id}: runtime::Gc<NativeCell<{ty}>> = native_lexical_cell({:?});", local.name).unwrap();
                    return;
                }
                writeln!(
                    output,
                    "let {local_id}: runtime::Gc<NativeCell<{ty}>> = native_cell({});",
                    expr(init, function, module)
                )
                .unwrap();
            } else {
                writeln!(
                    output,
                    "let {mutable}{local_id}: {ty} = {};",
                    expr(init, function, module)
                )
                .unwrap();
            }
        }
        Stmt::Assign {
            local_id, value, ..
        } => {
            if let Some(global) = module.global(local_id) {
                output.push_str(&storage::write(
                    module,
                    function,
                    stmt,
                    global,
                    expr(value, function, module),
                ));
                return;
            }
            if function.locals.iter().any(|l| l.id == *local_id && l.boxed) {
                if let Expr::LibCall { r#fn, args, .. } = value
                    && r#fn == "lexical.initialize"
                {
                    writeln!(output, "{{ let value = {}; {local_id}.with_mut(|cell| cell.value = Some(value)); }}", expr(&args[0], function, module)).unwrap();
                    return;
                }
                writeln!(
                    output,
                    "{{ let value = {}; native_cell_write(&{local_id}, value); }}",
                    expr(value, function, module)
                )
                .unwrap();
            } else {
                writeln!(output, "{local_id} = {};", expr(value, function, module)).unwrap();
            }
        }
        Stmt::Expression { expr: value, .. } => {
            writeln!(output, "{};", expr(value, function, module)).unwrap();
        }
        Stmt::Return { value, .. } => {
            let value = value
                .as_ref()
                .map(|v| expr(v, function, module))
                .unwrap_or_else(|| "()".into());
            let closes = flow
                .targets
                .iter()
                .rev()
                .filter(|target| target.region == flow.region)
                .filter_map(|target| target.iterator_close.as_deref())
                .collect::<Vec<_>>();
            if !closes.is_empty() {
                writeln!(output, "{{ let native_return = {value};").unwrap();
                for generator in closes {
                    writeln!(
                        output,
                        "let _ = runtime::generator_return(&{generator}, None);"
                    )
                    .unwrap();
                }
                if protected {
                    output.push_str("return runtime::Completion::Return(native_return); }\n");
                } else {
                    output.push_str("return native_return; }\n");
                }
                return;
            }
            if protected {
                writeln!(output, "return runtime::Completion::Return({value});").unwrap();
            } else {
                writeln!(output, "return {value};").unwrap();
            }
        }
        Stmt::If {
            cond, then, else_, ..
        } => {
            writeln!(output, "if {} {{", expr(cond, function, module)).unwrap();
            for stmt in then {
                statement_with_flow(stmt, function, module, output, flow);
            }
            output.push('}');
            if let Some(other) = else_ {
                output.push_str(" else {\n");
                for stmt in other {
                    statement_with_flow(stmt, function, module, output, flow);
                }
                output.push('}');
            }
            output.push('\n');
        }
        Stmt::While { cond, body, .. } => {
            let id = flow.targets.len();
            let head = if matches!(cond, Expr::BoolLit { value: true, .. }) {
                "loop".into()
            } else {
                format!("while {}", expr(cond, function, module))
            };
            writeln!(output, "'native_loop_{id}: {head} {{").unwrap();
            let mut inner = flow.clone();
            inner.targets.push(JumpTarget {
                region: flow.region,
                allows_continue: true,
                iterator_close: None,
            });
            for stmt in body {
                statement_with_flow(stmt, function, module, output, &inner);
            }
            output.push_str("}\n");
        }
        Stmt::Break { target_depth, .. } | Stmt::Continue { target_depth, .. } => {
            let id = flow
                .targets
                .iter()
                .enumerate()
                .rev()
                .filter(|(_, target)| matches!(stmt, Stmt::Break { .. }) || target.allows_continue)
                .nth(*target_depth)
                .map(|(index, _)| index)
                .expect("validated jump target");
            let close_start = if matches!(stmt, Stmt::Break { .. }) {
                id
            } else {
                id + 1
            };
            iterator_closes(output, &flow.targets, flow.region, close_start);
            if flow.targets[id].region == flow.region {
                let jump = if matches!(stmt, Stmt::Break { .. }) {
                    "break"
                } else {
                    "continue"
                };
                writeln!(output, "{jump} 'native_loop_{id};").unwrap();
            } else {
                let jump = if matches!(stmt, Stmt::Break { .. }) {
                    "Break"
                } else {
                    "Continue"
                };
                writeln!(output, "return runtime::Completion::{jump}({id});").unwrap();
            }
        }
        Stmt::Block { body, .. } => {
            output.push_str("{\n");
            for stmt in body {
                statement_with_flow(stmt, function, module, output, flow);
            }
            output.push_str("}\n");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporary_byte_values_require_the_runtime_without_typed_locals() {
        let loc = crate::ir::Loc {
            file: "temporary.ts".into(),
            start: 0,
            end: 1,
        };
        let module = Module {
            ir_version: crate::ir::VERSION,
            source_file: "temporary.ts".into(),
            source_modules: vec![],
            entry: "__main".into(),
            records: vec![],
            unions: vec![],
            globals: vec![],
            classes: vec![],
            functions: vec![Function {
                is_async: false,
                generator: None,
                rest: false,
                name: "__main".into(),
                params: vec![],
                captures: None,
                return_type: Type::Void,
                locals: vec![],
                loc: loc.clone(),
                body: vec![Stmt::Expression {
                    expr: Expr::Intrinsic {
                        name: "console.log".into(),
                        args: vec![Expr::BytesIntrinsic {
                            method: "length".into(),
                            receiver: Box::new(Expr::BytesNew {
                                source: None,
                                r#type: Type::bytes(),
                                loc: loc.clone(),
                            }),
                            args: vec![],
                            r#type: Type::F64,
                            loc: loc.clone(),
                        }],
                        r#type: Type::Void,
                        loc: loc.clone(),
                    },
                    loc,
                }],
            }],
        };
        crate::ir::validate(&module).unwrap();
        assert!(uses_runtime(&module));
        let measured = rust_with_metrics(&module).unwrap();
        assert_eq!(rust(&module).unwrap(), measured.source);
        assert_eq!(
            measured.abi_and_root_bytes + measured.function_body_bytes.values().sum::<usize>(),
            measured.source.len()
        );
        assert_eq!(
            measured.section_bytes.values().sum::<usize>(),
            measured.source.len()
        );
        assert!(measured.retained_adapters <= measured.adapter_definitions);
        assert!(measured.function_body_bytes["temporary.ts"] > 0);
    }

    #[test]
    fn direct_only_functions_do_not_allocate_callable_abis() {
        let loc = crate::ir::Loc {
            file: "direct-only.ts".into(),
            start: 0,
            end: 1,
        };
        let module = Module {
            ir_version: crate::ir::VERSION,
            source_file: loc.file.clone(),
            source_modules: vec![],
            entry: "__main".into(),
            records: vec![],
            unions: vec![],
            globals: vec![],
            classes: vec![],
            functions: vec![
                Function {
                    is_async: false,
                    generator: None,
                    rest: false,
                    name: "__main".into(),
                    params: vec![],
                    captures: None,
                    return_type: Type::Void,
                    locals: vec![],
                    body: vec![Stmt::Expression {
                        expr: Expr::Intrinsic {
                            name: "console.log".into(),
                            args: vec![Expr::Call {
                                callee: "helper".into(),
                                args: vec![],
                                r#type: Type::F64,
                                loc: loc.clone(),
                            }],
                            r#type: Type::Void,
                            loc: loc.clone(),
                        },
                        loc: loc.clone(),
                    }],
                    loc: loc.clone(),
                },
                Function {
                    is_async: false,
                    generator: None,
                    rest: false,
                    name: "helper".into(),
                    params: vec![],
                    captures: None,
                    return_type: Type::F64,
                    locals: vec![],
                    body: vec![Stmt::Return {
                        value: Some(Expr::NumLit {
                            value: 1.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: loc.clone(),
                        }),
                        loc: loc.clone(),
                    }],
                    loc,
                },
            ],
        };
        crate::ir::validate(&module).unwrap();
        let source = rust(&module).unwrap();
        assert!(source.contains("fn helper() -> f64"));
        assert!(!source.contains("static FN_1:"));
        assert!(!source.contains("type NativeFunction0"));
    }

    #[test]
    fn async_entry_with_uncaught_monitor_emits_one_observed_root() {
        let loc = crate::ir::Loc {
            file: "async-entry.ts".into(),
            start: 0,
            end: 1,
        };
        let dynamic_listener = Expr::DynFrom {
            value: Box::new(Expr::StrLit {
                value: "listener".into(),
                r#type: Type::String,
                loc: loc.clone(),
            }),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let module = Module {
            ir_version: crate::ir::VERSION,
            source_file: loc.file.clone(),
            source_modules: vec![],
            entry: "__main".into(),
            records: vec![],
            unions: vec![],
            globals: vec![],
            classes: vec![],
            functions: vec![Function {
                is_async: true,
                generator: None,
                rest: false,
                name: "__main".into(),
                params: vec![],
                captures: None,
                return_type: Type::Void,
                locals: vec![],
                loc: loc.clone(),
                body: vec![
                    Stmt::Expression {
                        expr: Expr::LibCall {
                            r#fn: "process.onUncaughtMonitor".into(),
                            args: vec![dynamic_listener],
                            r#type: Type::Void,
                            loc: loc.clone(),
                        },
                        loc: loc.clone(),
                    },
                    Stmt::Return { value: None, loc },
                ],
            }],
        };
        let source = rust(&module).unwrap();
        assert!(source.contains("let root_outcome:"));
        assert!(source.contains("runtime::promise_then(root"));
        assert!(source.contains("runtime::run_event_loop_with_uncaught_handler"));
        assert!(source.contains("runtime::init()"));
        assert!(source.contains("runtime::finish()"));
        assert!(!source.contains("runtime::init_sync()"));
        assert!(!source.contains("native async module entry with uncaught exception listeners"));
    }

    #[test]
    fn large_entry_global_prefix_is_split_without_reordering() {
        let loc = crate::ir::Loc {
            file: "large-entry.ts".into(),
            start: 0,
            end: 1,
        };
        let globals = (0..129)
            .map(|index| crate::ir::Global {
                id: format!("%g.{index}"),
                name: format!("g{index}"),
                r#type: Type::F64,
                mutable: false,
                loc: loc.clone(),
            })
            .collect::<Vec<_>>();
        let body = globals
            .iter()
            .enumerate()
            .map(|(index, global)| Stmt::Assign {
                local_id: global.id.clone(),
                value: Expr::NumLit {
                    value: index as f64,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                },
                initializes_global: true,
                loc: loc.clone(),
            })
            .chain(std::iter::once(Stmt::Return {
                value: None,
                loc: loc.clone(),
            }))
            .collect();
        let module = Module {
            ir_version: crate::ir::VERSION,
            source_file: loc.file.clone(),
            source_modules: vec![],
            entry: "__main".into(),
            records: vec![],
            unions: vec![],
            globals,
            classes: vec![],
            functions: vec![Function {
                is_async: false,
                generator: None,
                rest: false,
                name: "__main".into(),
                params: vec![],
                captures: None,
                return_type: Type::Void,
                locals: vec![],
                body,
                loc,
            }],
        };
        crate::ir::validate(&module).unwrap();
        let source = rust(&module).unwrap();
        assert!(source.contains("fn native_entry_initializers_0()"));
        assert!(source.contains("fn native_entry_initializers_1()"));
        assert!(source.contains("fn native_entry_initializers_2()"));
        let entry = source.split("fn __main()").nth(1).unwrap();
        let first = entry.find("native_entry_initializers_0();").unwrap();
        let second = entry.find("native_entry_initializers_1();").unwrap();
        let third = entry.find("native_entry_initializers_2();").unwrap();
        assert!(first < second && second < third);
        assert!(!entry.contains("GLOBAL_128.with"));
    }
}
