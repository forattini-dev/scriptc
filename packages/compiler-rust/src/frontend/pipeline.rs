use super::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticUnit {
    file: String,
    start: i32,
    end: i32,
    kind: String,
    diagnostic: Option<String>,
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
    diagnostic_groups: std::collections::BTreeMap<String, Vec<usize>>,
    units: Vec<DiagnosticUnit>,
}

enum Outcome {
    Module(Module),
    Diagnostics(Diagnostics),
}

pub fn lower(input: &Path, work: &Path, project: Option<&Path>) -> Result<Module, String> {
    match lower_internal(input, work, project, None)? {
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
    match lower_internal(input, work, project, Some((max_units, linked, start_unit)))? {
        Outcome::Diagnostics(report) => Ok(report),
        Outcome::Module(_) => unreachable!("diagnostic lowering never produces a module"),
    }
}

fn lower_internal(
    input: &Path,
    work: &Path,
    project: Option<&Path>,
    diagnostic: Option<(usize, bool, usize)>,
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
    let _checked_scope = source_frontend::core::enter_program(Some(checked));
    crate::trace_phase("frontend binding", || {
        program::bind_all();
        Ok(())
    })?;
    crate::trace_phase("frontend type checking", check_program)?;
    let execution = crate::trace_phase("frontend execution view", || {
        Ok(needs_execution_view().then(|| crate::project::execution_view(options.clone())))
    })?;
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
            })
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
            lowerer.projections = linked.projections;
            lowerer.literal_choices = linked.literal_choices;
        }
        let plan = crate::trace_phase("frontend module planning", || {
            modules::ModulePlan::link(lowerer.checker, file)
        })?;
        lowerer.unobserved_default_exports =
            modules::unobserved_defaults(lowerer.checker, &plan.modules);
        lowerer.inventory_commonjs(&plan)?;
        for binding in &plan.bindings {
            match binding {
                modules::ImportBinding::NativeRequire { name, module } => {
                    let symbol = lowerer.checker.get_symbol_at_location(*name, false).0;
                    lowerer.commonjs.local_symbols.insert(symbol);
                    lowerer
                        .commonjs
                        .native_declarations
                        .insert(declarations::Key::of(name.parent()));
                    lowerer.native_namespaces.insert(symbol, module);
                }
                modules::ImportBinding::CommonJs { .. } => {}
                modules::ImportBinding::Native { node, module, file } => {
                    lowerer.file = file.clone();
                    lowerer.native_import(*node, module);
                }
                modules::ImportBinding::Json { node, path, file } => {
                    lowerer.file = file.clone();
                    lowerer.json_import(*node, path)?;
                }
            }
        }
        crate::trace_phase("frontend inventories", || {
            lowerer.plan_value_layouts(&plan.modules);
            lowerer.plan_contextual_record_storage(&plan.modules);
            lowerer.inventory(&plan.modules);
            lowerer.inventory_enums(&plan.modules)?;
            lowerer.inventory_classes(&plan.modules);
            lowerer.inventory_data_tables(&plan.modules);
            lowerer.inventory_storage(&plan.modules);
            Ok(())
        })?;
        let mut body = lowerer.commonjs_prelude();
        body.extend(lowerer.hoist_module_vars(&plan.modules)?);
        if let Some((max_units, linked, start_unit)) = diagnostic {
            let mut candidates = Vec::new();
            let mut skipped_commonjs_modules = 0;
            for module in &plan.execution_order {
                if !linked && *module != file {
                    continue;
                }
                if lowerer.commonjs_index(*module).is_some() {
                    skipped_commonjs_modules += 1;
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
            let mut units = Vec::new();
            for (module, node) in candidates.into_iter().skip(start_unit).take(max_units) {
                let path = source_file_info(module).file_name.to_string();
                let mut probe = lowerer.diagnostic_fork();
                probe.file = path.clone();
                let result = (|| -> Result<(), String> {
                    if node.kind() == SyntaxKind::FunctionDeclaration {
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
                        if let Some(index) = probe.classes.next() {
                            probe.lower_constructor(index)?;
                        } else if let Some(signature) = probe.classes.next_method() {
                            probe.lower_function(signature)?;
                        } else if let Some((symbol, signature)) = probe.functions.next() {
                            probe
                                .lower_function(signature)
                                .map_err(|error| probe.functions.explain(symbol, error))?;
                            probe.functions.finish(symbol);
                        } else {
                            break;
                        }
                    }
                    Ok(())
                })();
                units.push(DiagnosticUnit {
                    file: path,
                    start: node.pos(),
                    end: node.end(),
                    kind: format!("{:?}", node.kind()),
                    diagnostic: result.err(),
                });
            }
            let mut diagnostic_groups = std::collections::BTreeMap::<String, Vec<usize>>::new();
            for (index, unit) in units.iter().enumerate() {
                if let Some(first) = unit
                    .diagnostic
                    .as_deref()
                    .and_then(|error| error.lines().next())
                {
                    diagnostic_groups
                        .entry(first.into())
                        .or_default()
                        .push(start_unit + index);
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
                scope: "Independent statement and function probes share the checked project but not lowering state; prior initializers are not executed. Uncalled functions are included. Failures may reflect missing prerequisites or generic ABI inference; success is not a valid IR, Rust, or executable certificate. CommonJS modules are skipped. Normal build remains authoritative.",
                analyzed_units: units.len(),
                available_units,
                start_unit,
                skipped_commonjs_modules,
                truncated: start_unit.saturating_add(units.len()) < available_units,
                diagnostic_groups,
                units,
            }));
        }
        for file in &plan.execution_order {
            lowerer.file = source_file_info(*file).file_name.to_string();
            if let Some(index) = lowerer.commonjs_index(*file) {
                body.push(Stmt::Expression {
                    expr: lowerer.commonjs_call(index, *file),
                    loc: lowerer.loc(*file),
                });
                body.extend(lowerer.commonjs_snapshots(index, *file));
            } else {
                body.extend(lowerer.statements(file.statements())?);
            }
        }
        let mut functions = vec![Function {
            is_async: false,
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
        functions.extend(lowerer.lower_commonjs()?);
        loop {
            if let Some(index) = lowerer.classes.next() {
                functions.push(lowerer.lower_constructor(index)?);
                continue;
            }
            if let Some(signature) = lowerer.classes.next_method() {
                functions.push(lowerer.lower_function(signature)?);
                continue;
            }
            let Some((symbol, signature)) = lowerer.functions.next() else {
                break;
            };
            let function = lowerer
                .lower_function(signature)
                .map_err(|error| lowerer.functions.explain(symbol, error))?;
            lowerer.functions.finish(symbol);
            functions.push(function);
        }
        lowerer.populate_dynamic_constructors()?;
        functions[0].body.splice(0..0, lowerer.namespace_prelude());
        let boxed_prelude = lowerer.boxed_prelude();
        functions[0].body.splice(0..0, boxed_prelude);
        functions.extend(std::mem::take(&mut lowerer.lifted));
        lowerer.validate_call_receivers(&functions)?;
        lowerer.link_runtime_types(&functions, file)?;
        Ok(Outcome::Module(Module {
            ir_version: ir::VERSION,
            source_file: source.clone(),
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

pub(super) fn check_program() -> Result<(), String> {
    let mut diagnostics = program::get_config_file_parsing_diagnostics();
    diagnostics.extend(program::get_program_diagnostics());
    diagnostics.extend(program::get_syntactic_diagnostics(Node::NIL));
    diagnostics.extend(program::get_semantic_diagnostics(Node::NIL));
    diagnostics.extend(program::get_global_diagnostics());
    if !diagnostics.is_empty() {
        return Err(diagnostics
            .iter()
            .map(program::format_diagnostic)
            .collect::<Vec<_>>()
            .join("\n"));
    }
    Ok(())
}
