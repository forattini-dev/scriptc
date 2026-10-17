//! Conservative source prerequisites, independent of first-error lowering.
//! All locations are retained; uncalled bodies are deliberately included.
use super::*;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    schema_version: u32,
    entry: String,
    frontend_revision: &'static str,
    engine: &'static str,
    scope: &'static str,
    sources: Vec<String>,
    module_plan_diagnostic: Option<String>,
    linked_modules: Option<usize>,
    linked_sources: Option<Vec<String>>,
    requirements: BTreeMap<String, Vec<Loc>>,
    builtin_calls: BTreeMap<String, LibraryRequirement>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryRequirement {
    signature_available: bool,
    locations: Vec<Loc>,
}

type Imports = HashMap<u32, (&'static str, Option<String>)>;

pub fn inspect(input: &Path, work: &Path, project: Option<&Path>) -> Result<Report, String> {
    let (options, checked) = crate::project::load(input, work, project)?;
    let _checked = source_frontend::core::enter_program(Some(checked));
    program::bind_all();
    pipeline::check_program()?;
    let execution = crate::project::execution_view(options);
    let _execution = source_frontend::core::enter_program(Some(execution));
    program::bind_all();
    let mut files = program::source_files()
        .into_iter()
        .filter(|file| {
            let name = source_file_info(*file).file_name.to_string();
            !is_declaration(&name) && !name.ends_with(".json")
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|file| source_file_info(*file).file_name.to_string());
    let entry = path_for_frontend(input);
    let file = files
        .iter()
        .copied()
        .find(|f| source_file_info(*f).file_name == entry)
        .ok_or("SCN0002: inspection entry not loaded")?;
    program::with_type_checker_for_file(file, move |checker| {
        let plan = modules::ModulePlan::link(checker, file);
        let mut report = Report {
            schema_version: 1,
            entry,
            frontend_revision: REVISION,
            engine: "none",
            scope: "all non-declaration execution-resolver sources, including uncalled bodies; prerequisites only, not a build certificate or complete semantic gap analysis",
            sources: files
                .iter()
                .map(|f| source_file_info(*f).file_name.to_string())
                .collect(),
            module_plan_diagnostic: plan.as_ref().err().cloned(),
            linked_modules: plan.as_ref().ok().map(|p| p.modules.len()),
            linked_sources: plan.as_ref().ok().map(|p| {
                let mut names = p
                    .modules
                    .iter()
                    .map(|f| source_file_info(*f).file_name.to_string())
                    .collect::<Vec<_>>();
                names.sort();
                names
            }),
            requirements: BTreeMap::new(),
            builtin_calls: BTreeMap::new(),
        };
        for file in files {
            let mut imports = Imports::new();
            inventory_imports(checker, file, &mut imports);
            visit(checker, file, &imports, &mut report);
        }
        Ok(report)
    })
}

fn symbol(checker: &mut Checker, node: Node) -> u32 {
    checker.get_symbol_at_location(node, false).0
}
fn inventory_imports(checker: &mut Checker, node: Node, imports: &mut Imports) {
    if node.kind() == SyntaxKind::ImportDeclaration
        && let Some(specifier) = modules::runtime_specifier(node)
        && let Some(module) = builtins::module(specifier.text())
    {
        let clause = node.import_clause();
        if !clause.is_nil() {
            if !clause.name().is_nil() {
                imports.insert(symbol(checker, clause.name()), (module, None));
            }
            let bindings = clause.named_bindings();
            if !bindings.is_nil() {
                if bindings.kind() == SyntaxKind::NamespaceImport {
                    imports.insert(symbol(checker, bindings.name()), (module, None));
                } else {
                    for binding in bindings.elements() {
                        if binding.is_type_only() {
                            continue;
                        }
                        let name = if binding.property_name().is_nil() {
                            binding.name()
                        } else {
                            binding.property_name()
                        };
                        imports.insert(
                            symbol(checker, binding.name()),
                            (module, Some(name.text().into())),
                        );
                    }
                }
            }
        }
    }
    if node.kind() == SyntaxKind::VariableDeclaration
        && node.name().kind() == SyntaxKind::Identifier
    {
        let init = node.initializer();
        if !init.is_nil()
            && init.kind() == SyntaxKind::CallExpression
            && init.expression().kind() == SyntaxKind::Identifier
            && init.expression().text() == "require"
            && init.arguments().len() == 1
            && init.arguments().get(0).kind() == SyntaxKind::StringLiteral
            && let Some(module) = builtins::module(init.arguments().get(0).text())
        {
            let callee = checker.get_symbol_at_location(init.expression(), false);
            let declaration = if callee.0 == 0 {
                Node::NIL
            } else {
                checker.sym(callee).value_declaration
            };
            if declaration.is_nil()
                || is_declaration(
                    &source_file_info(source_frontend::prelude::get_source_file_of_node(
                        declaration,
                    ))
                    .file_name,
                )
            {
                imports.insert(symbol(checker, node.name()), (module, None));
            }
        }
    }
    node.for_each_child(&mut |child| {
        inventory_imports(checker, child, imports);
        false
    });
}
fn visit(checker: &mut Checker, node: Node, imports: &Imports, report: &mut Report) {
    if matches!(
        node.kind(),
        SyntaxKind::InterfaceDeclaration
            | SyntaxKind::TypeAliasDeclaration
            | SyntaxKind::JsTypeAliasDeclaration
    ) {
        return;
    }
    let location = || Loc {
        file: source_file_info(source_frontend::prelude::get_source_file_of_node(node))
            .file_name
            .to_string(),
        start: node.pos().max(0),
        end: node.end(),
    };
    let category = match node.kind() {
        SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression => {
            Some("class-layout-and-inheritance")
        }
        SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor => {
            Some("class-or-object-method")
        }
        SyntaxKind::TryStatement => Some("exception-handlers"),
        SyntaxKind::ThrowStatement => Some("throw"),
        SyntaxKind::AwaitExpression => Some("await"),
        SyntaxKind::YieldExpression => Some("generators"),
        SyntaxKind::ForStatement
        | SyntaxKind::ForOfStatement
        | SyntaxKind::ForInStatement
        | SyntaxKind::WhileStatement
        | SyntaxKind::DoStatement => Some("source-loops-and-iteration"),
        SyntaxKind::SwitchStatement => Some("switch"),
        SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern => Some("destructuring"),
        SyntaxKind::SpreadAssignment | SyntaxKind::SpreadElement => Some("spread"),
        SyntaxKind::FunctionDeclaration
        | SyntaxKind::FunctionExpression
        | SyntaxKind::ArrowFunction
            if node.modifier_flags().intersects(ModifierFlags::ASYNC) =>
        {
            Some("async-functions")
        }
        SyntaxKind::CallExpression if node.expression().kind() == SyntaxKind::ImportKeyword => {
            Some("dynamic-import")
        }
        _ => None,
    };
    if let Some(category) = category {
        report
            .requirements
            .entry(category.into())
            .or_default()
            .push(location());
    }
    if node.kind() == SyntaxKind::CallExpression {
        let callee = node.expression();
        let binding = if callee.kind() == SyntaxKind::Identifier {
            imports
                .get(&symbol(checker, callee))
                .cloned()
                .and_then(|(m, n)| n.map(|n| (m, n)))
        } else if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.expression().kind() == SyntaxKind::Identifier
        {
            imports
                .get(&symbol(checker, callee.expression()))
                .filter(|(_, n)| n.is_none())
                .map(|(m, _)| (*m, callee.name().text().to_string()))
        } else {
            None
        };
        if let Some((module, member)) = binding {
            let requirement = report
                .builtin_calls
                .entry(format!("{module}.{member}"))
                .or_insert_with(|| LibraryRequirement {
                    signature_available: builtins::get(module, &member).is_some(),
                    locations: Vec::new(),
                });
            requirement.locations.push(location());
        }
    }
    node.for_each_child(&mut |child| {
        visit(checker, child, imports, report);
        false
    });
}
