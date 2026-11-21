use super::*;
use serde::Serialize;

fn reconcile_dynamic_call_arguments(
    functions: &mut [Function],
    can_erase: impl Fn(&Type) -> bool,
) -> usize {
    let final_parameters = functions.iter().map(|function| {
        (function.name.clone(), function.params.iter().map(|parameter| parameter.r#type.clone()).collect::<Vec<_>>())
    }).collect::<HashMap<_, _>>();
    let mut reconciled = 0;
    for function in functions {
        ir::walk_mut::function(function, &mut |expression| {
            let Expr::Call { callee, args, loc, .. } = expression else { return; };
            let Some(parameters) = final_parameters.get(callee.as_str()) else { return; };
            for (argument, parameter) in args.iter_mut().zip(parameters) {
                let actual = argument.ty();
                if *parameter == Type::Dyn
                    && matches!(
                        actual,
                        Type::Bytes { .. }
                            | Type::Array { .. }
                            | Type::Record { .. }
                            | Type::F64
                            | Type::String
                            | Type::Bool
                            | Type::Generator { r#async: false, .. }
                    )
                    && can_erase(&actual)
                {
                    *argument = Expr::DynFrom {
                        value: Box::new(argument.clone()),
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    };
                    reconciled += 1;
                }
            }
        });
    }
    reconciled
}

/// A closure value can be created while its target still has the ABI of an
/// earlier demand; a later demand may widen parameters to Dyn. Keep the
/// closure's published ABI and route it through an adapter that boxes each
/// widened argument once and calls the final function.
fn reconcile_closure_signatures(
    functions: &mut Vec<Function>,
    can_erase: impl Fn(&Type) -> bool,
) -> usize {
    let finals = functions
        .iter()
        .map(|function| (function.name.clone(), function.clone()))
        .collect::<HashMap<_, _>>();
    let mut adapters: Vec<(String, Type, String)> = Vec::new();
    let mut created: Vec<Function> = Vec::new();
    let mut reconciled = 0;
    for function in functions.iter_mut() {
        ir::walk_mut::function(function, &mut |expression| {
            let Expr::Closure { fn_name, captures, r#type, loc } = expression else {
                return;
            };
            let Some(target) = finals.get(fn_name.as_str()) else {
                return;
            };
            let Type::Func { params, ret, rest } = r#type.clone() else {
                return;
            };
            let final_params = target.params.iter().map(|p| p.r#type.clone()).collect::<Vec<_>>();
            if params == final_params && *ret == target.call_result() && rest == target.rest {
                return;
            }
            let compatible = captures.is_empty()
                && target.captures.as_ref().is_none_or(|captures| captures.is_empty())
                && !rest
                && !target.rest
                && *ret == target.call_result()
                && params.len() == final_params.len()
                && params.iter().zip(&final_params).all(|(old, new)| {
                    old == new || (*new == Type::Dyn && can_erase(old))
                });
            if !compatible {
                return;
            }
            let name = if let Some((_, _, name)) = adapters
                .iter()
                .find(|(callee, ty, _)| callee == fn_name && *ty == *r#type)
            {
                name.clone()
            } else {
                let name = format!("{fn_name}$abi{}", adapters.len());
                let parameters = params
                    .iter()
                    .enumerate()
                    .map(|(index, ty)| Param {
                        local_id: format!("p{index}"),
                        name: format!("arg{index}"),
                        r#type: ty.clone(),
                    })
                    .collect::<Vec<_>>();
                let args = parameters
                    .iter()
                    .zip(&final_params)
                    .map(|(parameter, target_type)| {
                        let read = Expr::VarRef {
                            local_id: parameter.local_id.clone(),
                            r#type: parameter.r#type.clone(),
                            loc: loc.clone(),
                        };
                        if parameter.r#type == *target_type {
                            read
                        } else {
                            Expr::DynFrom {
                                value: Box::new(read),
                                r#type: Type::Dyn,
                                loc: loc.clone(),
                            }
                        }
                    })
                    .collect::<Vec<_>>();
                let call = Expr::Call {
                    callee: fn_name.clone(),
                    args,
                    r#type: target.call_result(),
                    loc: loc.clone(),
                };
                let body = if target.call_result() == Type::Void {
                    vec![
                        Stmt::Expression { expr: call, loc: loc.clone() },
                        Stmt::Return { value: None, loc: loc.clone() },
                    ]
                } else {
                    vec![Stmt::Return { value: Some(call), loc: loc.clone() }]
                };
                created.push(Function {
                    is_async: false,
                    generator: None,
                    rest: false,
                    name: name.clone(),
                    locals: parameters
                        .iter()
                        .map(|parameter| Local {
                            id: parameter.local_id.clone(),
                            name: parameter.name.clone(),
                            r#type: parameter.r#type.clone(),
                            mutable: false,
                            boxed: false,
                        })
                        .collect(),
                    params: parameters,
                    captures: None,
                    return_type: target.call_result(),
                    body,
                    loc: loc.clone(),
                });
                adapters.push((fn_name.clone(), r#type.clone(), name.clone()));
                name
            };
            *fn_name = name;
            reconciled += 1;
        });
    }
    functions.extend(created);
    reconciled
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticUnit {
    file: String,
    start: i32,
    end: i32,
    kind: String,
    diagnostic: Option<String>,
    diagnostics: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncModuleDiagnostic {
    file: String,
    has_top_level_await: bool,
    in_static_import_cycle: bool,
    await_sites: Vec<module_graph::AwaitSite>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    kind: &'static str,
    schema_version: u32,
    compiler: &'static str,
    engine: &'static str,
    frontend_revision: &'static str,
    entry: String,
    project: Option<String>,
    scope: &'static str,
    analyzed_units: usize,
    available_units: usize,
    start_unit: usize,
    skipped_commonjs_modules: usize,
    truncated: bool,
    declaration_catalog_skipped: bool,
    global_inventories_skipped: bool,
    typescript_diagnostics: Vec<String>,
    planning_diagnostics: Vec<String>,
    diagnostic_groups: std::collections::BTreeMap<String, Vec<usize>>,
    modules_reaching_top_level_await: Vec<AsyncModuleDiagnostic>,
    pub(crate) source_modules: Vec<ir::SourceModule>,
    units: Vec<DiagnosticUnit>,
}

enum Outcome {
    Module(Module),
    Diagnostics(Diagnostics),
}

pub fn lower(
    input: &Path,
    work: &Path,
    project: Option<&Path>,
    allow_semantic_errors: bool,
) -> Result<Module, String> {
    match lower_internal(input, work, project, None, allow_semantic_errors)? {
        Outcome::Module(module) => Ok(module),
        Outcome::Diagnostics(_) => unreachable!("ordinary lowering produces a module"),
    }
}

pub fn diagnose(
    input: &Path,
    work: &Path,
    project: Option<&Path>,
    max_units: usize,
    linked: bool,
    start_unit: usize,
) -> Result<Diagnostics, String> {
    match lower_internal(
        input,
        work,
        project,
        Some((max_units, linked, start_unit)),
        false,
    )? {
        Outcome::Diagnostics(report) => Ok(report),
        Outcome::Module(_) => unreachable!("diagnostic lowering never produces a module"),
    }
}

fn lower_internal(
    input: &Path,
    work: &Path,
    project: Option<&Path>,
    diagnostic: Option<(usize, bool, usize)>,
    allow_semantic_errors: bool,
) -> Result<Outcome, String> {
    if input.to_str().is_none() {
        return Err("SCN0001: non-Unicode input paths are not ported".into());
    }
    let source = path_for_frontend(input);
    let crate::project::Loaded {
        options,
        checked,
        console_prelude,
    } = crate::trace_phase("frontend project load", || {
        crate::project::load(input, work, project)
    })?;
    // Keep the checked program only until an execution view has been built.
    // Large applications otherwise retain checked, execution, and contract
    // checker tables at the same time, even though lowering reads only the
    // execution view after this point.
    let mut checked_scope = Some(source_frontend::core::enter_program(Some(checked)));
    crate::trace_phase("frontend binding", || {
        program::bind_all();
        Ok(())
    })?;
    let typescript_diagnostics = crate::trace_phase("frontend type checking", || {
        check_program(diagnostic.is_some() || allow_semantic_errors)
    })?;
    if diagnostic.is_none() && allow_semantic_errors && !typescript_diagnostics.is_empty() {
        eprintln!(
            "scriptc: proceeding past {} semantic TypeScript diagnostic(s) by explicit request; native lowering and IR validation remain required",
            typescript_diagnostics.len()
        );
        for diagnostic in &typescript_diagnostics {
            eprintln!("{diagnostic}");
        }
    }
    let execution = crate::trace_phase("frontend execution view", || {
        Ok(needs_execution_view().then(|| crate::project::execution_view(options.clone())))
    })?;
    if execution.is_some() {
        drop(checked_scope.take());
        source_frontend::program::release_program(checked);
    }
    let _execution_scope =
        execution.map(|program| source_frontend::core::enter_program(Some(program)));
    let catalog = crate::trace_phase("frontend declaration snapshot", || {
        if execution.is_some() {
            crate::trace_phase("frontend execution binding", || {
                program::bind_all();
                Ok(())
            })?;
            let syntax = crate::trace_phase("frontend execution syntax", || {
                Ok(program::get_syntactic_diagnostics(Node::NIL))
            })?;
            if !syntax.is_empty() {
                return Err(syntax
                    .iter()
                    .map(program::format_diagnostic)
                    .collect::<Vec<_>>()
                    .join("\n"));
            }
            // The full declaration-contract catalog walks every implementation
            // and declaration reachable through max-depth node_modules. It is
            // required to emit authoritative IR, but it used to make a
            // diagnostic page pay the monolithic cost before probing even one
            // unit. The execution view still supplies all linked JS bodies;
            // isolated diagnostics intentionally accept weaker ABI hints and
            // already label resulting failures as potentially secondary.
            if diagnostic.is_some() {
                return Ok(None);
            }
            let roots = program::source_files()
                .into_iter()
                .map(|f| source_file_info(f).file_name.to_string())
                .filter(|f| !is_declaration(f))
                .collect();
            let method_demands = crate::trace_phase("frontend member demands", || {
                declarations::member_demands(&source)
            })?;
            let contracts = crate::trace_phase("frontend contract view", || {
                Ok(crate::project::contract_view(options, roots))
            })?;
            let catalog = {
                let _contracts_scope = source_frontend::core::enter_program(Some(contracts));
                crate::trace_phase("frontend contract binding", || {
                    program::bind_all();
                    Ok(())
                })?;
                crate::trace_phase("frontend declaration catalog", || {
                    Ok(Some(declarations::snapshot(
                        &source,
                        console_prelude.clone(),
                        method_demands,
                    )?))
                })?
            };
            source_frontend::program::release_program(contracts);
            Ok(catalog)
        } else {
            Ok(None)
        }
    })?;
    let file = program::source_files()
        .into_iter()
        .find(|node| source_file_info(*node).file_name == source)
        .ok_or_else(|| "SCN0002: frontend did not return the input source file".to_string())?;
    let project_label = project.map(path_for_frontend);
    program::with_type_checker_for_file(file, move |checker| {
        let linked = catalog.map(|catalog| catalog.link(checker));
        let mut lowerer = Lowerer::new(checker, source.clone(), console_prelude);
        if let Some(linked) = linked {
            lowerer.records = linked.records;
            lowerer.unions = linked.unions;
            lowerer.callables = linked.callables;
            lowerer.declarations = linked.hints;
            lowerer.projections = std::sync::Arc::new(linked.projections);
            lowerer.literal_choices = linked.literal_choices;
            lowerer.namespace_aliases = linked.namespace_aliases;
            lowerer.install_standard_function_facades();
            lowerer.register_referenced_builtin_classes(file);
        }
        let plan = crate::trace_phase("frontend module planning", || {
            modules::ModulePlan::link(lowerer.checker, file, diagnostic.is_some())
        })?;
        let mut planning_diagnostics = plan.planning_diagnostics.clone();
        lowerer.missing_dynamic_imports = plan.missing_dynamic_imports.clone();
        for (index, module) in plan.lazy_modules.iter().enumerate() {
            lowerer.lazy_modules.insert(
                source_file_info(*module).file_name.to_string(),
                format!("%lazy_module_{index}"),
            );
        }
        lowerer.unobserved_default_exports =
            modules::unobserved_defaults(lowerer.checker, &plan.modules);
        planning_diagnostics.extend(lowerer.inventory_commonjs(&plan, diagnostic.is_some())?);
        for binding in &plan.bindings {
            match binding {
                modules::ImportBinding::Asset {
                    node,
                    path,
                    file,
                    kind,
                } => {
                    lowerer.file = file.clone();
                    if let Err(error) = lowerer.asset_import(*node, path, *kind) {
                        if diagnostic.is_some() {
                            planning_diagnostics.push(error);
                        } else {
                            return Err(error);
                        }
                    }
                }
                modules::ImportBinding::NativeRequire {
                    call,
                    declaration,
                    module,
                } => {
                    lowerer
                        .native_require_calls
                        .insert(declarations::Key::of(*call), module);
                    if !declaration.is_nil()
                        && declaration.name().kind() == SyntaxKind::ObjectBindingPattern
                    {
                        lowerer
                            .commonjs
                            .native_declarations
                            .insert(declarations::Key::of(*declaration));
                        lowerer.bind_native_pattern(declaration.name(), module);
                    } else if !declaration.is_nil()
                        && declaration.name().kind() == SyntaxKind::Identifier
                    {
                        let name = declaration.name();
                        let symbol = lowerer.checker.get_symbol_at_location(name, false).0;
                        lowerer.commonjs.local_symbols.insert(symbol);
                        lowerer
                            .commonjs
                            .native_declarations
                            .insert(declarations::Key::of(*declaration));
                        lowerer.native_namespaces.insert(symbol, module);
                    }
                }
                modules::ImportBinding::CommonJs { .. } => {}
                modules::ImportBinding::Native { node, module, file } => {
                    lowerer.file = file.clone();
                    lowerer.native_import(*node, module);
                }
                modules::ImportBinding::Json { node, path, file } => {
                    lowerer.file = file.clone();
                    if let Err(error) = lowerer.json_import(*node, path) {
                        if diagnostic.is_some() {
                            planning_diagnostics.push(error);
                        } else {
                            return Err(error);
                        }
                    }
                }
            }
        }
        let linked_diagnostics = diagnostic.is_some_and(|(_, linked, _)| linked);
        if diagnostic.is_none() || linked_diagnostics {
            crate::trace_phase("frontend inventories", || {
                let commonjs_files =
                    crate::trace_phase("frontend CommonJS inventory files", || {
                        Ok(lowerer.commonjs_files())
                    })?;
                crate::trace_phase("frontend implemented interface inventory", || {
                    lowerer.inventory_implemented_interfaces(&plan.modules);
                    Ok(())
                })?;
                crate::trace_phase("frontend value layout planning", || {
                    lowerer.plan_value_layouts(&plan.modules);
                    Ok(())
                })?;
                crate::trace_phase("frontend contextual storage planning", || {
                    lowerer.plan_contextual_record_storage(&plan.modules);
                    Ok(())
                })?;
                crate::trace_phase("frontend declaration inventory", || {
                    lowerer.inventory(&plan.modules);
                    Ok(())
                })?;
                crate::trace_phase("frontend enum inventory", || {
                    lowerer.inventory_enums(&plan.modules)
                })?;
                crate::trace_phase("frontend class inventory", || {
                    lowerer.inventory_classes(&plan.modules);
                    Ok(())
                })?;
                // The first ABI pass intentionally precedes class inventory so
                // record/container layouts can be solved without demanding class
                // bodies. Run a monotone nominal pass once class identities exist:
                // emitted JavaScript dependencies can expose `new Class()` as
                // checker `any`, while the AST constructor still proves the
                // concrete owning instance forwarded through private helpers.
                crate::trace_phase("frontend nominal parameter planning", || {
                    lowerer.plan_parameter_abi(&plan.modules);
                    Ok(())
                })?;
                crate::trace_phase("frontend data table inventory", || {
                    lowerer.inventory_data_tables(&plan.modules);
                    Ok(())
                })?;
                crate::trace_phase("frontend module storage inventory", || {
                    lowerer.inventory_storage(&plan.modules);
                    Ok(())
                })?;
                crate::trace_phase("frontend CommonJS storage inventory", || {
                    lowerer.inventory_storage(&commonjs_files);
                    Ok(())
                })?;
                crate::trace_phase("frontend default export inventory", || {
                    lowerer.inventory_default_exports(&plan.modules)
                })?;
                lowerer.install_standard_function_facades();
                Ok(())
            })?;
        }
        let mut body = Vec::new();
        if diagnostic.is_none() {
            body = lowerer.commonjs_prelude();
            body.extend(lowerer.enum_prelude()?);
            body.extend(lowerer.asset_prelude());
            body.extend(lowerer.hoist_module_vars(&plan.modules)?);
        }
        if let Some((max_units, linked, start_unit)) = diagnostic {
            let await_sites = plan
                .graph_files
                .iter()
                .map(|file| module_graph::top_level_await_sites(*file))
                .collect::<Vec<_>>();
            let direct = await_sites
                .iter()
                .map(|sites| !sites.is_empty())
                .collect::<Vec<_>>();
            let reaches_await = plan.graph.async_closure(&direct);
            let mut cyclic = vec![false; plan.graph_files.len()];
            for component in plan.graph.components() {
                if component.len() > 1 || plan.graph.edges[component[0]].contains(&component[0]) {
                    for index in component {
                        cyclic[index] = true;
                    }
                }
            }
            let modules_reaching_top_level_await = plan
                .graph_files
                .iter()
                .enumerate()
                .filter(|(index, _)| reaches_await[*index])
                .map(|(index, file)| AsyncModuleDiagnostic {
                    file: source_file_info(*file).file_name.to_string(),
                    has_top_level_await: direct[index],
                    in_static_import_cycle: cyclic[index],
                    await_sites: await_sites[index].clone(),
                })
                .collect();
            let mut candidates = Vec::new();
            let skipped_commonjs_modules = 0;
            // Dynamic targets are not evaluated at entry, but linked
            // diagnostics must still inspect them for independent errors.
            let mut diagnostic_modules = plan.execution_order.clone();
            for module in &plan.graph_files {
                if !diagnostic_modules.contains(module) {
                    diagnostic_modules.push(*module);
                }
            }
            for module in lowerer.commonjs_files() {
                if !diagnostic_modules.contains(&module) {
                    diagnostic_modules.push(module);
                }
            }
            for module in &diagnostic_modules {
                if !linked && *module != file {
                    continue;
                }
                if lowerer.commonjs_index(*module).is_some() {
                    candidates.push((*module, *module));
                    continue;
                }
                for node in module.statements() {
                    if matches!(
                        node.kind(),
                        SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration
                    ) {
                        continue;
                    }
                    candidates.push((*module, node));
                }
            }
            let available_units = candidates.len();
            if start_unit > available_units {
                return Err(format!(
                    "SCN0001: --start-unit {start_unit} exceeds {available_units} available units"
                ));
            }
            let mut journal = std::env::var_os("SCRIPTC_DIAGNOSTIC_JOURNAL")
                .map(|path| {
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(path)
                })
                .transpose()
                .map_err(|e| format!("SCN0001: diagnostic journal: {e}"))?;
            let mut units = Vec::new();
            for (offset, (module, node)) in candidates
                .into_iter()
                .skip(start_unit)
                .take(max_units)
                .enumerate()
            {
                if std::env::var_os("SCRIPTC_TRACE_DIAGNOSTIC_UNITS").is_some() {
                    eprintln!(
                        "scriptc: diagnosing unit {} {:?} at {}:{}..{}",
                        start_unit + offset,
                        node.kind(),
                        source_file_info(module).file_name,
                        node.pos(),
                        node.end()
                    );
                }
                let path = source_file_info(module).file_name.to_string();
                let mut probe = lowerer.diagnostic_fork();
                probe.file = path.clone();
                probe.diagnostic_errors = Some(Vec::new());
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                    || -> Result<(), String> {
                        if node.kind() == SyntaxKind::SourceFile
                            && probe.commonjs_index(node).is_some()
                        {
                            probe.lower_commonjs_selected(Some(node))?;
                        } else if node.kind() == SyntaxKind::FunctionDeclaration {
                            let symbol = if node.name().is_nil() {
                                node.symbol().0
                            } else {
                                probe.symbol(node.name())
                            };
                            probe.request_function(symbol, node, functions::UseKind::Value)?;
                        } else {
                            probe.statement(node)?;
                        }
                        loop {
                            let result = if let Some(index) = probe.classes.next() {
                                let restore = probe.diagnostic_checkpoint();
                                match probe.lower_constructor(index) {
                                    Ok(_) => Ok(()),
                                    Err(error) => {
                                        restore(&mut probe);
                                        Err(error)
                                    }
                                }
                            } else if let Some(signature) = probe.classes.next_method() {
                                let restore = probe.diagnostic_checkpoint();
                                match probe.lower_function(signature) {
                                    Ok(_) => Ok(()),
                                    Err(error) => {
                                        restore(&mut probe);
                                        Err(error)
                                    }
                                }
                            } else if let Some((symbol, signature)) = probe.functions.next() {
                                let restore = probe.diagnostic_checkpoint();
                                let result = match probe.lower_function(signature) {
                                    Ok(_) => Ok(()),
                                    Err(error) => {
                                        restore(&mut probe);
                                        Err(probe.functions.explain(symbol, error))
                                    }
                                };
                                probe.functions.finish(symbol);
                                result
                            } else {
                                break;
                            };
                            if let Err(error) = result {
                                probe.diagnostic_errors.as_mut().unwrap().push(error);
                            }
                        }
                        Ok(())
                    },
                ))
                .unwrap_or_else(|payload| {
                    let detail = payload
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                        .unwrap_or("non-string checker panic");
                    Err(format!(
                        "SCN9001: isolated lowering probe panicked: {detail}"
                    ))
                });
                let mut diagnostics = probe.diagnostic_errors.take().unwrap_or_default();
                if let Err(error) = result {
                    diagnostics.push(error);
                }
                diagnostics.dedup();
                units.push(DiagnosticUnit {
                    file: path,
                    start: node.pos(),
                    end: node.end(),
                    kind: format!("{:?}", node.kind()),
                    diagnostic: diagnostics.first().cloned(),
                    diagnostics,
                });
                if let Some(journal) = &mut journal {
                    use std::io::Write;
                    serde_json::to_writer(&mut *journal, units.last().unwrap())
                        .map_err(|e| e.to_string())?;
                    writeln!(journal).map_err(|e| e.to_string())?;
                    journal.flush().map_err(|e| e.to_string())?;
                }
            }
            let mut diagnostic_groups = std::collections::BTreeMap::<String, Vec<usize>>::new();
            for (index, unit) in units.iter().enumerate() {
                for error in &unit.diagnostics {
                    if let Some(first) = error.lines().next() {
                        let entries = diagnostic_groups.entry(first.into()).or_default();
                        let index = start_unit + index;
                        if !entries.contains(&index) {
                            entries.push(index);
                        }
                    }
                }
            }

            return Ok(Outcome::Diagnostics(Diagnostics {
                kind: "isolated-lowering-diagnostics",
                schema_version: 1,
                compiler: "rust",
                engine: "none",
                frontend_revision: super::REVISION,
                entry: source.clone(),
                project: project_label,
                scope: if linked {
                    "Diagnostic-only statement recovery rolls back failed lowering mutations and continues at the next statement; later errors may be secondary to missing bindings. Independent statement and function probes share the checked project and build-grade global layout inventories, but prior initializers are not executed. Uncalled functions are included. Semantic TypeScript errors and recoverable module-planning failures are reported but do not stop probes. Isolated checker panics become unit diagnostics, so failures may still reflect missing initializer state or generic inference; success is not a valid IR, Rust, or executable certificate. CommonJS module initializers are probed in their own module context; uncalled CommonJS exports may remain undemanded. Normal build remains authoritative."
                } else {
                    "Diagnostic-only statement recovery rolls back failed lowering mutations and continues at the next statement; later errors may be secondary to missing bindings. Independent statement and function probes share the checked project but not lowering state; prior initializers are not executed. Uncalled functions are included. Semantic TypeScript errors and recoverable module-planning failures are reported but do not stop probes. Dependency declaration catalogs and global layout inventories are skipped, and isolated checker panics become unit diagnostics, so failures may reflect missing ABI hints, prerequisites or generic inference; success is not a valid IR, Rust, or executable certificate. CommonJS module initializers are probed in their own module context; uncalled CommonJS exports may remain undemanded. Normal build remains authoritative."
                },
                analyzed_units: units.len(),
                available_units,
                start_unit,
                skipped_commonjs_modules,
                truncated: start_unit.saturating_add(units.len()) < available_units,
                declaration_catalog_skipped: execution.is_some(),
                global_inventories_skipped: !linked,
                typescript_diagnostics,
                planning_diagnostics,
                diagnostic_groups,
                modules_reaching_top_level_await,
                source_modules: plan.source_modules(),
                units,
            }));
        }
        let entry_candidate = file
            .statements()
            .into_iter()
            .last()
            .is_some_and(|statement| {
                if statement.kind() != SyntaxKind::ExpressionStatement {
                    return false;
                }
                let call = primitives::primitive_source(statement.expression());
                if call.kind() == SyntaxKind::AwaitExpression {
                    return true;
                }
                if call.kind() != SyntaxKind::CallExpression
                    || !lowerer.process_member(call.expression(), "exit")
                {
                    return false;
                }
                let args = call.arguments().into_iter().collect::<Vec<_>>();
                args.len() == 1
                    && primitives::primitive_source(args[0]).kind() == SyntaxKind::AwaitExpression
            });
        let only_entry_suspends = entry_candidate
            && plan.graph_files.iter().all(|module| {
                *module == file || module_graph::top_level_await_sites(*module).is_empty()
            });
        let mut async_entry = false;
        for module in &plan.execution_order {
            lowerer.file = source_file_info(*module).file_name.to_string();
            if std::env::var_os("SCRIPTC_TRACE_FUNCTIONS").is_some() {
                eprintln!(
                    "scriptc: lowering module {} (+{} ms)",
                    lowerer.file,
                    crate::trace_elapsed_ms()
                );
            }
            if let Some(index) = lowerer.commonjs_index(*module) {
                body.push(Stmt::Expression {
                    expr: lowerer.commonjs_call(index, *module),
                    loc: lowerer.loc(*module),
                });
                body.extend(lowerer.commonjs_snapshots(index, *module));
            } else {
                let statements = module.statements().into_iter().collect::<Vec<_>>();
                let terminal = statements.last().copied().filter(|statement| {
                    if *module != file
                        || !only_entry_suspends
                        || statement.kind() != SyntaxKind::ExpressionStatement
                    {
                        return false;
                    }
                    let call = primitives::primitive_source(statement.expression());
                    if call.kind() == SyntaxKind::AwaitExpression {
                        return module_graph::top_level_await_sites(*module).len() == 1;
                    }
                    if call.kind() != SyntaxKind::CallExpression
                        || !lowerer.process_member(call.expression(), "exit")
                    {
                        return false;
                    }
                    let args = call.arguments().into_iter().collect::<Vec<_>>();
                    args.len() == 1
                        && primitives::primitive_source(args[0]).kind()
                            == SyntaxKind::AwaitExpression
                        && module_graph::top_level_await_sites(*module).len() == 1
                });
                for statement in statements
                    .iter()
                    .take(statements.len() - usize::from(terminal.is_some()))
                {
                    body.extend(lowerer.statement(*statement)?);
                }
                if let Some(statement) = terminal {
                    let call = primitives::primitive_source(statement.expression());
                    let direct = call.kind() == SyntaxKind::AwaitExpression;
                    let await_node = if direct {
                        call
                    } else {
                        primitives::primitive_source(call.arguments().into_iter().next().unwrap())
                    };
                    let terminal_type = if direct {
                        // A top-level await expression discards its fulfilled
                        // value. Keep the Await as a terminal return so the
                        // continuation emitter can resume and complete the
                        // async entry without inventing a typed local.
                        Type::Void
                    } else {
                        Type::F64
                    };
                    let awaited = lowerer.terminal_await(await_node, &terminal_type)?;
                    if !direct {
                        lowerer.ensure_exception_classes(call)?;
                    }
                    if direct {
                        body.push(Stmt::Return {
                            value: Some(awaited),
                            loc: lowerer.loc(await_node),
                        });
                    } else {
                        let local = lowerer.construction_local(terminal_type, false);
                        body.push(Stmt::VarDecl {
                            local_id: local.id.clone(),
                            init: awaited,
                            loc: lowerer.loc(await_node),
                        });
                        body.push(Stmt::Expression {
                            expr: Expr::LibCall {
                                r#fn: "process.exit".into(),
                                args: vec![lowerer.construction_read(&local, await_node)],
                                r#type: Type::Void,
                                loc: lowerer.loc(call),
                            },
                            loc: lowerer.loc(statement),
                        });
                    }
                    if !direct {
                        body.push(Stmt::Return {
                            value: None,
                            loc: lowerer.loc(statement),
                        });
                    }
                    async_entry = true;
                }
            }
        }
        let mut functions = vec![Function {
            is_async: async_entry,
            generator: None,
            rest: false,
            name: "__main".into(),
            params: vec![],
            captures: None,
            return_type: Type::Void,
            locals: std::mem::take(&mut lowerer.locals),
            body,
            loc: Loc {
                file: source.clone(),
                start: 0,
                end: file.end(),
            },
        }];
        for module in &plan.lazy_modules {
            lowerer.file = source_file_info(*module).file_name.to_string();
            lowerer.locals.clear();
            lowerer.bindings.clear();
            lowerer.var_defined.clear();
            let mut body = Vec::new();
            let index = plan
                .graph_files
                .iter()
                .position(|file| file == module)
                .expect("linked lazy module");
            for dependency in &plan.graph.edges[index] {
                let target = plan.graph_files[*dependency];
                let path = source_file_info(target).file_name.to_string();
                if let Some(name) = lowerer.lazy_modules.get(&path) {
                    body.push(Stmt::Expression {
                        expr: Expr::Call {
                            callee: name.clone(),
                            args: vec![],
                            r#type: Type::Void,
                            loc: lowerer.loc(*module),
                        },
                        loc: lowerer.loc(*module),
                    });
                } else if let Some(index) = lowerer.commonjs_file_index(&path) {
                    body.push(Stmt::Expression {
                        expr: lowerer.commonjs_call(index, *module),
                        loc: lowerer.loc(*module),
                    });
                    body.extend(lowerer.commonjs_snapshots(index, *module));
                }
            }
            for statement in module.statements() {
                body.extend(lowerer.statement(statement)?);
            }
            functions.push(Function {
                is_async: false,
                generator: None,
                rest: false,
                name: lowerer.lazy_modules[&lowerer.file].clone(),
                params: vec![],
                captures: None,
                return_type: Type::Void,
                locals: std::mem::take(&mut lowerer.locals),
                body,
                loc: lowerer.loc(*module),
            });
        }
        functions.extend(crate::trace_phase("frontend CommonJS lowering", || {
            lowerer.lower_commonjs()
        })?);
        let mut dynamic_receivers_scanned = 0;
        let mut demanded_dynamic_methods = HashSet::new();
        loop {
            for (interface, names) in lowerer.classes.take_deferred_interface_methods() {
                for (_, class) in lowerer.classes.source_class_candidates() {
                    if !matches!(
                        class.kind(),
                        SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                    ) || class.name().is_nil()
                    {
                        continue;
                    }
                    let symbol = lowerer.checker.get_symbol_at_location(class.name(), false);
                    if symbol.0 == 0 {
                        continue;
                    }
                    let instance = lowerer.checker.get_declared_type_of_symbol(symbol);
                    if !lowerer.checker.is_type_assignable_to(instance, interface) {
                        continue;
                    }
                    let Some(index) = lowerer.classes.definition_index_for_node(class) else {
                        continue;
                    };
                    for name in &names {
                        if let Some((owner, method)) = lowerer.classes.method_candidate(index, name)
                        {
                            lowerer.request_method(owner, name, method)?;
                        }
                    }
                }
            }
            for (declaration, name) in lowerer.classes.take_deferred_erased_methods() {
                if let Some(owner) = lowerer
                    .classes
                    .definition_index_for_node(declaration.parent())
                {
                    lowerer.request_method(owner, &name, declaration)?;
                }
            }
            if let Some(index) = lowerer.classes.next() {
                if std::env::var_os("SCRIPTC_TRACE_FUNCTIONS").is_some() {
                    eprintln!("scriptc: lowering constructor {index}");
                }
                functions.push(lowerer.lower_constructor(index)?);
                continue;
            }
            if let Some(signature) = lowerer.classes.next_method() {
                if std::env::var_os("SCRIPTC_TRACE_FUNCTIONS").is_some() {
                    eprintln!(
                        "scriptc: lowering method {} at {}:{}..{}",
                        signature.name,
                        signature.file,
                        signature.node.pos(),
                        signature.node.end()
                    );
                }
                functions.push(lowerer.lower_function(signature)?);
                continue;
            }
            let Some((symbol, signature)) = lowerer.functions.next() else {
                // Erasing a class-typed receiver into a dynamic invocation
                // still dispatches to that class's prototype methods. Demand
                // their erased implementations so the dispatcher has a slot.
                let mut erased_receivers = Vec::new();
                let mut invoked_methods = std::collections::BTreeSet::new();
                let mut boxed_classes = std::collections::BTreeSet::new();
                let mut collect = |value: &Expr| {
                    if let Expr::DynInvoke { recv, method, .. } = value {
                        invoked_methods.insert(method.clone());
                        if let Expr::DynFrom { value: source, .. } = recv.as_ref() {
                            erased_receivers.push((source.ty(), method.clone()));
                        }
                    }
                    // `erased.get(key)` extracts the method value first.
                    if let Expr::DynKeyGet { key, .. } = value
                        && let Expr::StrLit { value: name, .. } = key.as_ref()
                    {
                        invoked_methods.insert(name.clone());
                    }
                    // A class instance boxed anywhere (for example stored in
                    // an interface-typed field) can later receive any
                    // dynamically invoked method name.
                    if let Expr::DynFrom { value: source, .. } = value
                        && let Type::Object { class_name } = source.ty()
                    {
                        boxed_classes.insert(class_name);
                    }
                    // An erased class value can be constructed dynamically
                    // (`new registry.Socket(...)`); its instances then
                    // receive dynamically invoked methods.
                    if let Expr::DynFrom { value: source, .. } = value
                        && let Type::Classval { class_name } = source.ty()
                    {
                        boxed_classes.insert(class_name);
                    }
                };
                for function in &functions[dynamic_receivers_scanned..] {
                    function.visit_expressions(&mut collect);
                }
                for function in &lowerer.lifted.0 {
                    function.visit_expressions(&mut collect);
                }
                dynamic_receivers_scanned = functions.len();
                for class_name in &boxed_classes {
                    for method in &invoked_methods {
                        erased_receivers.push((
                            Type::Object {
                                class_name: class_name.clone(),
                            },
                            method.clone(),
                        ));
                    }
                }
                let mut requested = false;
                for (source, method) in erased_receivers {
                    for declaration in
                        lowerer.classes.dynamic_method_candidates_for_type(&source, &method, &lowerer.unions)
                    {
                        let Some(owner) = lowerer.classes.definition_index_for_node(declaration.parent())
                        else {
                            continue;
                        };
                        if demanded_dynamic_methods.insert((owner, method.clone()))
                            && lowerer.request_dynamic_method(owner, &method, declaration).is_ok()
                        {
                            requested = true;
                        }
                    }
                }
                // Dynamic reads of a getter on a boxed instance (for example
                // `cache.size` through an interface field) need the getter.
                for class_name in &boxed_classes {
                    for name in &invoked_methods {
                        if let Some((owner, getter)) =
                            lowerer.classes.getter_candidate(class_name, name)
                            && demanded_dynamic_methods.insert((owner, format!("get:{name}")))
                            && lowerer.request_accessor(owner, name, false, getter).is_ok()
                        {
                            requested = true;
                        }
                    }
                }
                if requested {
                    continue;
                }
                let pending = lowerer.classes.missing_dynamic_method_specializations();
                if pending.is_empty() {
                    break;
                }
                for (owner, name, node) in pending {
                    lowerer.request_dynamic_method(owner, &name, node)?;
                }
                continue;
            };
            if std::env::var_os("SCRIPTC_TRACE_FUNCTIONS").is_some() {
                eprintln!(
                    "scriptc: lowering function {} at {}:{}..{}",
                    signature.name,
                    signature.file,
                    signature.node.pos(),
                    signature.node.end()
                );
            }
            let function = lowerer
                .lower_function(signature)
                .map_err(|error| lowerer.functions.explain(symbol, error))?;
            lowerer.functions.finish(symbol);
            functions.push(function);
        }
        crate::trace_phase("frontend dynamic constructors", || {
            lowerer.populate_dynamic_constructors()
        })?;
        crate::trace_phase("frontend namespace type linking", || {
            lowerer.link_namespace_layouts(&functions, file);
            Ok(())
        })?;
        functions[0].body.splice(0..0, lowerer.namespace_prelude());
        let boxed_prelude = lowerer.boxed_prelude();
        functions[0].body.splice(0..0, boxed_prelude);
        let console_prelude = lowerer.console_global_prelude();
        functions[0].body.splice(0..0, console_prelude);
        functions.extend(lowerer.lifted.take());
        // A later demand can widen a queued private function's parameter to
        // Dyn after an earlier caller has already been lowered. Reconcile the
        // resulting direct calls against the final signature before linking
        // runtime types. Boxing preserves the original container owner and
        // evaluates the argument exactly once; descriptor-sensitive values
        // remain refused by the ordinary erasure boundary.
        reconcile_dynamic_call_arguments(&mut functions, |actual| {
            !matches!(actual, Type::Record { shape_id } if lowerer.callables.contains_key(shape_id))
                && lowerer.dynamic_erasure_reason(actual).is_none()
        });
        reconcile_closure_signatures(&mut functions, |actual| {
            !matches!(actual, Type::Record { shape_id } if lowerer.callables.contains_key(shape_id))
                && lowerer.dynamic_erasure_reason(actual).is_none()
        });
        crate::trace_phase("frontend call receiver validation", || {
            lowerer.validate_call_receivers(&functions)
        })?;
        crate::trace_phase("frontend runtime type linking", || {
            lowerer.link_runtime_types(&functions, file)
        })?;
        crate::trace_phase("frontend class layout finalization", || {
            lowerer.finalize_class_layouts()
        })?;
        let source_modules = plan.source_modules();
        Ok(Outcome::Module(Module {
            ir_version: ir::VERSION,
            source_file: source.clone(),
            source_modules,
            entry: "__main".into(),
            functions,
            records: lowerer.records,
            unions: lowerer.unions,
            globals: lowerer.globals,
            classes: lowerer
                .classes
                .layouts
                .into_iter()
                .flatten()
                .chain(lowerer.namespace_values.layouts)
                .collect(),
        }))
    })
}

pub(super) fn check_program(allow_semantic_errors: bool) -> Result<Vec<String>, String> {
    // Configuration, syntax and global-environment errors can invalidate the
    // AST/checker contract itself, so they remain fatal in every mode.
    let mut blocking = program::get_config_file_parsing_diagnostics();
    blocking.extend(program::get_program_diagnostics());
    blocking.extend(program::get_syntactic_diagnostics(Node::NIL));
    blocking.extend(program::get_global_diagnostics());
    if !blocking.is_empty() {
        return Err(blocking
            .iter()
            .map(program::format_diagnostic)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    // Semantic diagnostics still leave a usable checked tree. Normal builds
    // reject them, while diagnose records all of them and continues isolated
    // lowering so one consumer type error cannot hide compiler coverage gaps.
    let semantic = program::get_semantic_diagnostics(Node::NIL)
        .iter()
        .map(program::format_diagnostic)
        .collect::<Vec<_>>();
    if !allow_semantic_errors && !semantic.is_empty() {
        return Err(semantic.join("\n"));
    }
    Ok(semantic)
}

#[cfg(test)]
mod dynamic_call_reconciliation_tests {
    use super::*;

    fn loc() -> Loc {
        Loc { file: "late-abi.ts".into(), start: 0, end: 1 }
    }

    fn function(name: &str, params: Vec<Param>, body: Vec<Stmt>) -> Function {
        Function {
            is_async: false, generator: None, rest: false, name: name.into(), params,
            captures: None, return_type: Type::Void, locals: vec![], body, loc: loc(),
        }
    }

    fn call(callee: &str, value: Expr) -> Expr {
        Expr::Call { callee: callee.into(), args: vec![value], r#type: Type::Void, loc: loc() }
    }

    fn variable(name: &str, ty: Type) -> Expr {
        Expr::VarRef { local_id: name.into(), r#type: ty, loc: loc() }
    }

    #[test]
    fn reconciles_nested_calls_once_and_keeps_erasure_fences() {
        let bytes = Type::Bytes { elem: "u8".into() };
        let array = Type::Array { elem: Box::new(Type::String) };
        let record = Type::Record { shape_id: 1 };
        let blocked = Type::Record { shape_id: 7 };
        let param = |ty| Param { local_id: "p".into(), name: "p".into(), r#type: ty };
        let nested = Expr::Sequence {
            stmts: vec![Stmt::Expression { expr: call("dynamic", variable("array", array.clone())), loc: loc() }],
            result: Box::new(call("dynamic", variable("record", record))),
            r#type: Type::Void,
            loc: loc(),
        };
        let caller = function("caller", vec![], vec![Stmt::If {
            cond: Expr::BoolLit { value: true, r#type: Type::Bool, loc: loc() },
            then: vec![
                Stmt::Expression { expr: call("dynamic", variable("bytes", bytes)), loc: loc() },
                Stmt::Expression { expr: nested, loc: loc() },
            ],
            else_: Some(vec![
                Stmt::Expression { expr: call("dynamic", variable("blocked", blocked)), loc: loc() },
                Stmt::Expression { expr: call("fixed", variable("array", array.clone())), loc: loc() },
            ]),
            loc: loc(),
        }]);
        let mut functions = vec![function("dynamic", vec![param(Type::Dyn)], vec![]), function("fixed", vec![param(array)], vec![]), caller];
        let can_erase = |ty: &Type| !matches!(ty, Type::Record { shape_id: 7 });
        assert_eq!(reconcile_dynamic_call_arguments(&mut functions, can_erase), 3);
        assert_eq!(reconcile_dynamic_call_arguments(&mut functions, can_erase), 0);
        let mut boxed = 0;
        let mut blocked_or_fixed = 0;
        functions[2].visit_expressions(&mut |expression| {
            if let Expr::Call { callee, args, .. } = expression {
                if matches!(args.first(), Some(Expr::DynFrom { .. })) { boxed += 1; }
                if (callee == "fixed" || matches!(args.first().map(Expr::ty), Some(Type::Record { shape_id: 7 })))
                    && !matches!(args.first(), Some(Expr::DynFrom { .. })) { blocked_or_fixed += 1; }
            }
        });
        assert_eq!(boxed, 3);
        assert_eq!(blocked_or_fixed, 2);
    }

    #[test]
    fn widened_closure_targets_keep_their_published_abi_through_an_adapter() {
        let param = |ty| Param { local_id: "p".into(), name: "p".into(), r#type: ty };
        let published = Type::Func { params: vec![Type::String], ret: Box::new(Type::Void), rest: false };
        let closure = Expr::Closure { fn_name: "late".into(), captures: vec![], r#type: published.clone(), loc: loc() };
        let user = function("user", vec![], vec![Stmt::Expression { expr: closure.clone(), loc: loc() }, Stmt::Expression { expr: closure, loc: loc() }]);
        let mut functions = vec![function("late", vec![param(Type::Dyn)], vec![]), user];
        assert_eq!(reconcile_closure_signatures(&mut functions, |_| true), 2);
        assert_eq!(functions.len(), 3, "one adapter per target and published ABI");
        let adapter = &functions[2];
        assert_eq!(adapter.params[0].r#type, Type::String);
        assert!(matches!(&adapter.body[0], Stmt::Expression { expr: Expr::Call { callee, args, .. }, .. }
            if callee == "late" && matches!(args.as_slice(), [Expr::DynFrom { .. }])));
        let mut targets = Vec::new();
        functions[1].visit_expressions(&mut |expression| {
            if let Expr::Closure { fn_name, r#type, .. } = expression { targets.push((fn_name.clone(), r#type.clone())); }
        });
        assert_eq!(targets, vec![(adapter.name.clone(), published.clone()), (adapter.name.clone(), published)]);
        assert_eq!(reconcile_closure_signatures(&mut functions, |_| true), 0);
    }
}
