use super::*;

pub fn lower(input: &Path, work: &Path, project: Option<&Path>) -> Result<Module, String> {
    if input.to_str().is_none() {
        return Err("SCN0001: non-Unicode input paths are not ported".into());
    }
    let source = path_for_frontend(input);
    let (options, checked) = crate::project::load(input, work, project)?;
    let _checked_scope = source_frontend::core::enter_program(Some(checked));
    program::bind_all();
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
        let contracts = crate::project::contract_view(options, roots);
        let _contracts_scope = source_frontend::core::enter_program(Some(contracts));
        program::bind_all();
        Some(declarations::snapshot(&source)?)
    } else {
        None
    };
    let file = program::source_files()
        .into_iter()
        .find(|node| source_file_info(*node).file_name == source)
        .ok_or_else(|| "SCN0002: frontend did not return the input source file".to_string())?;
    program::with_type_checker_for_file(file, move |checker| {
        let linked = catalog.map(|catalog| catalog.link(checker));
        let mut lowerer = Lowerer::new(checker, source.clone());
        if let Some(linked) = linked {
            lowerer.records = linked.records;
            lowerer.unions = linked.unions;
            lowerer.callables = linked.callables;
            lowerer.declarations = linked.hints;
            lowerer.projections = linked.projections;
        }
        let plan = modules::ModulePlan::link(lowerer.checker, file)?;
        for binding in plan.bindings {
            match binding {
                modules::ImportBinding::Native { node, module, file } => {
                    lowerer.file = file;
                    lowerer.native_import(node, module);
                }
                modules::ImportBinding::Json { node, path, file } => {
                    lowerer.file = file;
                    lowerer.json_import(node, &path)?;
                }
            }
        }
        lowerer.inventory(&plan.evaluation_order);
        lowerer.inventory_enums(&plan.evaluation_order)?;
        lowerer.inventory_classes(&plan.evaluation_order);
        lowerer.inventory_storage(&plan.evaluation_order);
        let mut body = lowerer.hoist_module_vars(&plan.evaluation_order)?;
        for file in &plan.evaluation_order {
            lowerer.file = source_file_info(*file).file_name.to_string();
            body.extend(lowerer.statements(file.statements())?);
        }
        let mut functions = vec![Function {
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
        loop {
            if let Some(index) = lowerer.classes.next() {
                functions.push(lowerer.lower_constructor(index)?);
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
        functions.extend(lowerer.lifted);
        Ok(Module {
            ir_version: ir::VERSION,
            source_file: source.clone(),
            entry: "__main".into(),
            functions,
            records: lowerer.records,
            unions: lowerer.unions,
            globals: lowerer.globals,
            classes: lowerer.classes.layouts.into_iter().flatten().collect(),
        })
    })
}
