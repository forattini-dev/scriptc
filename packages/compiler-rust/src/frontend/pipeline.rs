use super::*;

pub fn lower(input: &Path, work: &Path, project: Option<&Path>) -> Result<Module, String> {
    if input.to_str().is_none() {
        return Err("SCN0001: non-Unicode input paths are not ported".into());
    }
    let source = path_for_frontend(input);
    let crate::project::Loaded {
        options,
        checked,
        console_prelude,
    } = crate::project::load(input, work, project)?;
    let _checked_scope = source_frontend::core::enter_program(Some(checked));
    program::bind_all();
    check_program()?;
    let needs_execution = needs_execution_view();
    let execution = needs_execution.then(|| crate::project::execution_view(options.clone()));
    let _execution_scope =
        execution.map(|program| source_frontend::core::enter_program(Some(program)));
    let catalog = if execution.is_some() {
        program::bind_all();
        let syntax = program::get_syntactic_diagnostics(Node::NIL);
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
        let method_demands = declarations::member_demands(&source)?;
        let contracts = crate::project::contract_view(options, roots);
        let _contracts_scope = source_frontend::core::enter_program(Some(contracts));
        program::bind_all();
        Some(declarations::snapshot(
            &source,
            console_prelude.clone(),
            method_demands,
        )?)
    } else {
        None
    };
    let file = program::source_files()
        .into_iter()
        .find(|node| source_file_info(*node).file_name == source)
        .ok_or_else(|| "SCN0002: frontend did not return the input source file".to_string())?;
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
        let plan = modules::ModulePlan::link(lowerer.checker, file)?;
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
        lowerer.plan_value_layouts(&plan.modules);
        lowerer.inventory(&plan.modules);
        lowerer.inventory_enums(&plan.modules)?;
        lowerer.inventory_classes(&plan.modules);
        lowerer.inventory_data_tables(&plan.modules);
        lowerer.inventory_storage(&plan.modules);
        let mut body = lowerer.commonjs_prelude();
        body.extend(lowerer.hoist_module_vars(&plan.modules)?);
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
        functions[0].body.splice(0..0, lowerer.namespace_prelude());
        let boxed_prelude = lowerer.boxed_prelude();
        functions[0].body.splice(0..0, boxed_prelude);
        functions.extend(std::mem::take(&mut lowerer.lifted));
        lowerer.validate_call_receivers(&functions)?;
        lowerer.link_runtime_types(&functions, file)?;
        Ok(Module {
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
        })
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
