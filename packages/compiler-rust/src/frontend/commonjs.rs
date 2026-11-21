//! Statically resolved CommonJS modules execute at their require site, once per module.
//! Export objects and the exports alias use owning native values, including cycles.
use super::*;
use source_frontend::prelude::{file_bind_data, get_source_file_of_node};

pub(super) fn is_module(file: Node) -> bool {
    let path = source_file_info(file).file_name.to_string();
    let format =
        program::get_source_file_meta_data(&source_file_info(file).path).implied_node_format;
    let external = source_file_info(file).external_module_indicator;
    // Forced module detection uses the SourceFile itself as a sentinel. An
    // actual import/export syntax node identifies an ESM source instead.
    !is_declaration(&path)
        && (external.is_nil() || external == file)
        && format == source_frontend::prelude::ModuleKind::COMMON_JS
        && (path.ends_with(".js")
            || path.ends_with(".cjs")
            || file_bind_data(file).common_js_module_indicator.is_some())
}

fn ambient(checker: &mut Checker, node: Node) -> bool {
    let symbol = checker.get_symbol_at_location(node, false);
    if symbol.0 == 0 {
        return true;
    }
    let declaration = checker.sym(symbol).value_declaration;
    declaration.is_nil()
        || declaration.kind() == SyntaxKind::SourceFile
        || is_declaration(&source_file_info(get_source_file_of_node(declaration)).file_name)
}

pub(super) fn require_calls(
    checker: &mut Checker,
    file: Node,
    out: &mut Vec<(Node, Node)>,
    tolerate_unsupported: bool,
) -> Result<Vec<String>, String> {
    fn report(
        error: String,
        tolerate_unsupported: bool,
        diagnostics: &mut Vec<String>,
    ) -> Result<(), String> {
        if tolerate_unsupported {
            diagnostics.push(error);
            Ok(())
        } else {
            Err(error)
        }
    }

    fn visit(
        checker: &mut Checker,
        node: Node,
        out: &mut Vec<(Node, Node)>,
        tolerate_unsupported: bool,
        diagnostics: &mut Vec<String>,
    ) -> Result<(), String> {
        let nested_initialized_module = node.kind() == SyntaxKind::VariableDeclaration
            && node.name().kind() == SyntaxKind::Identifier
            && node.name().text() == "module"
            && !node.initializer().is_nil()
            && node.parent().parent().parent().kind() != SyntaxKind::SourceFile;
        let nested_object_exports = node.kind() == SyntaxKind::VariableDeclaration
            && node.name().kind() == SyntaxKind::Identifier
            && node.name().text() == "exports"
            && node.initializer().kind() == SyntaxKind::ObjectLiteralExpression
            && node.initializer().properties().is_empty()
            && node.parent().parent().parent().kind() != SyntaxKind::SourceFile;
        if node.kind() == SyntaxKind::VariableDeclaration
            && node.parent().kind() == SyntaxKind::VariableDeclarationList
            && node.name().kind() == SyntaxKind::Identifier
            && matches!(node.name().text(), "exports" | "module" | "require")
            && !nested_initialized_module
            && !nested_object_exports
            && (!node
                .parent()
                .flags()
                .intersects(NodeFlags::LET | NodeFlags::CONST)
                || node.parent().parent().parent().kind() == SyntaxKind::SourceFile)
        {
            let file = get_source_file_of_node(node);
            if is_module(file) {
                report(
                    refusal(
                        &source_file_info(file).file_name,
                        node,
                        "CommonJS wrapper binding declarations are not ported",
                    ),
                    tolerate_unsupported,
                    diagnostics,
                )?;
            }
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.expression().kind() == SyntaxKind::Identifier
            && node.expression().text() == "require"
            && ambient(checker, node.expression())
        {
            let args = node.arguments();
            if args.len() == 1
                && (matches!(
                    args.get(0).kind(),
                    SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
                ) || modules::caught_by_enclosing_try(node))
            {
                out.push((node, args.get(0)));
            } else {
                report(
                    refusal(
                        &source_file_info(get_source_file_of_node(node)).file_name,
                        node,
                        "CommonJS require needs one literal request",
                    ),
                    tolerate_unsupported,
                    diagnostics,
                )?;
            }
        }
        let mut result = Ok(());
        node.for_each_child(&mut |child| {
            result = visit(checker, child, out, tolerate_unsupported, diagnostics);
            result.is_err()
        });
        result
    }
    let mut diagnostics = Vec::new();
    visit(checker, file, out, tolerate_unsupported, &mut diagnostics)?;
    Ok(diagnostics)
}

#[derive(Clone)]
pub(super) struct Instance {
    file: Node,
    module: Local,
    exports: Local,
    started: Local,
    name: String,
    json: Option<json_modules::DataValue>,
}

#[derive(Clone, Default)]
pub(super) struct Graph {
    instances: Vec<Instance>,
    files: HashMap<String, usize>,
    pub(super) requires: HashMap<declarations::Key, usize>,
    dynamic_imports: HashMap<declarations::Key, usize>,
    missing_requires: HashMap<declarations::Key, Node>,
    esm_requires: HashMap<declarations::Key, Node>,
    pub(super) local_symbols: HashSet<u32>,
    pub(super) native_declarations: HashSet<declarations::Key>,
    imports: HashMap<u32, (usize, Option<String>, Local)>,
    demanded_exports: HashMap<usize, HashSet<String>>,
    all_exports_demanded: HashSet<usize>,
    pruned_export_functions: HashSet<u32>,
}

#[derive(Clone)]
struct ExportDemandEdge {
    owner: usize,
    export: String,
    target: usize,
    member: Option<String>,
}

impl Lowerer<'_> {
    pub(super) fn commonjs_path_global(&self, node: Node) -> Option<String> {
        if node.kind() != SyntaxKind::Identifier
            || !matches!(node.text().as_ref(), "__filename" | "__dirname")
            || self.commonjs_file_index(&self.file).is_none()
        {
            return None;
        }
        if node.text() == "__filename" {
            return Some(self.file.clone());
        }
        Some(
            Path::new(&self.file)
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_string_lossy()
                .into_owned(),
        )
    }

    pub(super) fn commonjs_require_file(&self, call: Node) -> Option<Node> {
        let index = *self.commonjs.requires.get(&declarations::Key::of(call))?;
        self.commonjs
            .instances
            .get(index)
            .map(|instance| instance.file)
    }
    pub(super) fn commonjs_files(&self) -> Vec<Node> {
        self.commonjs
            .instances
            .iter()
            .filter(|instance| instance.json.is_none())
            .map(|instance| instance.file)
            .collect()
    }

    // Require aliases may appear in the source-file alias table even when
    // declared with block-scoped syntax. Resolve their storage from the
    // nearest lexical declaration instead of a canonical export symbol.
    pub(super) fn commonjs_lexical_symbol(
        &mut self,
        node: Node,
    ) -> Option<source_frontend::prelude::SymbolId> {
        let mut scope = node.parent();
        while !scope.is_nil() {
            if scope.kind() == SyntaxKind::Block {
                for statement in scope.statements() {
                    if statement.kind() != SyntaxKind::VariableStatement {
                        continue;
                    }
                    let list = statement.declaration_list();
                    if !list.flags().intersects(NodeFlags::LET | NodeFlags::CONST) {
                        continue;
                    }
                    for declaration in list.declarations().nodes() {
                        let name = declaration.name();
                        if name.kind() == SyntaxKind::Identifier && name.text() == node.text() {
                            return Some(self.checker.get_symbol_at_location(name, false));
                        }
                    }
                }
            }
            let symbol = self.checker.symbols.get(scope.locals(), node.text());
            if symbol.0 != 0
                && self
                    .checker
                    .sym(symbol)
                    .flags
                    .intersects(SymbolFlags::VALUE)
            {
                return Some(symbol);
            }
            scope = scope.parent();
        }
        None
    }

    fn commonjs_global(&mut self, name: &str, ty: Type) -> Local {
        let local = Local {
            id: format!("%g.{}", self.globals.len()),
            name: name.into(),
            r#type: ty,
            mutable: true,
            boxed: false,
        };
        self.globals.push(ir::Global {
            id: local.id.clone(),
            name: local.name.clone(),
            r#type: local.r#type.clone(),
            mutable: true,
            loc: Loc {
                file: self.file.clone(),
                start: 0,
                end: 0,
            },
        });
        local
    }

    pub(super) fn inventory_commonjs(
        &mut self,
        plan: &modules::ModulePlan,
        _allow_unsupported: bool,
    ) -> Result<Vec<String>, String> {
        let diagnostics = Vec::new();
        self.commonjs.esm_requires = plan
            .esm_requires
            .iter()
            .map(|(key, (_, target))| (key.clone(), *target))
            .collect();
        self.commonjs.missing_requires = plan.missing_requires.clone();
        let mut files = plan
            .modules
            .iter()
            .copied()
            .filter(|f| is_module(*f))
            .collect::<Vec<_>>();
        // JSON assets have no executable statements. Sort the lookup edges so
        // their module identities never depend on hash-map iteration order.
        let mut json_files = plan
            .requires
            .values()
            .copied()
            .filter(|f| source_file_info(*f).file_name.ends_with(".json"))
            .collect::<Vec<_>>();
        // ESM and require edges materialize one owning JSON module instance.
        for binding in &plan.bindings {
            if let modules::ImportBinding::Json { node, .. } = binding {
                let symbol = self
                    .checker
                    .get_symbol_at_location(node.module_specifier(), false);
                let target = self.checker.sym(symbol).value_declaration;
                if target.is_nil() || target.kind() != SyntaxKind::SourceFile {
                    return Err(self.refuse(*node, "JSON import has no resolved source asset"));
                }
                json_files.push(target);
            }
        }
        json_files.sort_by_key(|f| source_file_info(*f).file_name.to_string());
        json_files.dedup();
        files.extend(json_files);
        for file in files {
            let json = if source_file_info(file).file_name.ends_with(".json") {
                let path = source_file_info(file).file_name.to_string();
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("SCN0001: JSON module {path}: {e}"))?;
                Some(json_modules::parse(&bytes).map_err(|e| {
                    refusal(
                        &path,
                        file,
                        &format!("JSON module value is not representable: {e}"),
                    )
                })?)
            } else {
                None
            };
            let shape_id = self.records.len();
            self.records.push(ir::Record {
                id: shape_id,
                fields: vec![ir::Field {
                    name: "exports".into(),
                    r#type: Type::Dyn,
                }],
                declared_order: vec!["exports".into()],
                tuple: false,
                index_value: None,
            });
            let module = self.commonjs_global("module", Type::Record { shape_id });
            let exports = self.commonjs_global("exports", Type::Dyn);
            let started = self.commonjs_global("moduleLoaded", Type::Bool);
            let index = self.commonjs.instances.len();
            self.commonjs
                .files
                .insert(source_file_info(file).file_name.to_string(), index);
            self.commonjs.instances.push(Instance {
                file,
                module,
                exports,
                started,
                name: format!("cjs{index}"),
                json,
            });
        }
        for (site, target) in &plan.requires {
            let index = self.commonjs.files[&source_file_info(*target).file_name.to_string()];
            self.commonjs.requires.insert(site.clone(), index);
        }
        for (site, target) in &plan.dynamic_commonjs {
            let index = self.commonjs.files[&source_file_info(*target).file_name.to_string()];
            self.commonjs.dynamic_imports.insert(site.clone(), index);
        }
        for file in &plan.modules {
            self.file = source_file_info(*file).file_name.to_string();
            fn bindings(lowerer: &mut Lowerer<'_>, node: Node) {
                if node.kind() == SyntaxKind::CallExpression
                    && let Some(index) = lowerer.commonjs.requires.get(&declarations::Key::of(node))
                    && matches!(
                        lowerer.commonjs.instances[*index].json,
                        Some(json_modules::DataValue::Object(_))
                    )
                {
                    let ty = lowerer.checker.get_type_at_location(node);
                    lowerer.data_types.insert(ty);
                }
                let (name, value) = if node.kind() == SyntaxKind::VariableDeclaration {
                    (node.name(), node.initializer())
                } else if node.kind() == SyntaxKind::BinaryExpression
                    && node.operator_token().kind() == SyntaxKind::EqualsToken
                {
                    (node.left(), node.right())
                } else {
                    (Node::NIL, Node::NIL)
                };
                let mut value = value;
                while !value.is_nil() && value.kind() == SyntaxKind::ParenthesizedExpression {
                    value = value.expression();
                }
                if !name.is_nil() && name.kind() == SyntaxKind::Identifier && !value.is_nil() {
                    let source_symbol = if value.kind() == SyntaxKind::Identifier {
                        lowerer.symbol(value)
                    } else {
                        0
                    };
                    if lowerer
                        .commonjs
                        .requires
                        .contains_key(&declarations::Key::of(value))
                        || lowerer.commonjs_binding(value).is_some()
                        || lowerer.data_bindings.contains(&source_symbol)
                    {
                        let symbol = lowerer.checker.get_symbol_at_location(name, false).0;
                        lowerer.commonjs.local_symbols.insert(symbol);
                        lowerer.data_bindings.insert(symbol);
                    }
                }
                node.for_each_child(&mut |child| {
                    bindings(lowerer, child);
                    false
                });
            }
            loop {
                let count = self.data_bindings.len();
                bindings(self, *file);
                if self.data_bindings.len() == count {
                    break;
                }
            }
        }
        for binding in &plan.bindings {
            let modules::ImportBinding::CommonJs { node, target } = binding else {
                continue;
            };
            let index = self.commonjs.files[&source_file_info(*target).file_name.to_string()];
            if node.kind() == SyntaxKind::ExportDeclaration {
                let clause = node.export_clause();
                if !clause.is_nil() && clause.kind() == SyntaxKind::NamedExports {
                    for item in clause.elements() {
                        if item.is_type_only() {
                            continue;
                        }
                        let source = item.property_name_or_name().text().to_string();
                        self.commonjs_alias_override(item.name(), index, Some(source));
                    }
                    continue;
                }
                // `export *` contributes the checker's forwarded alias symbols
                // (never `default`). Register only symbols whose declaration
                // really belongs to this CommonJS target, so a local override
                // with the same spelling keeps ordinary ESM semantics.
                let owner = get_source_file_of_node(*node);
                let target_path = source_file_info(*target).file_name.to_string();
                for exported in self.checker.get_exports_of_module_as_array(owner.symbol()) {
                    let name = self.checker.sym(exported).name.to_string();
                    if name == "default" {
                        continue;
                    }
                    let resolved = if self
                        .checker
                        .sym(exported)
                        .flags
                        .intersects(SymbolFlags::ALIAS)
                    {
                        self.checker.get_aliased_symbol(exported)
                    } else {
                        exported
                    };
                    let declaration = self.checker.sym(resolved).value_declaration;
                    if declaration.is_nil()
                        || source_file_info(get_source_file_of_node(declaration)).file_name
                            != target_path
                    {
                        continue;
                    }
                    self.commonjs_alias_symbol(exported.0, &name, index, Some(name.clone()));
                }
                continue;
            }
            let clause = node.import_clause();
            if clause.is_nil() {
                continue;
            }
            if !clause.name().is_nil() {
                self.commonjs_alias(clause.name(), index, None);
            }
            let bindings = clause.named_bindings();
            if bindings.is_nil() {
                continue;
            }
            if bindings.kind() == SyntaxKind::NamespaceImport {
                // The namespace keeps the shared module.exports identity.
                // Named reads therefore observe the same object populated by
                // the wrapper, including cycles and later property writes.
                self.commonjs_alias(bindings.name(), index, None);
            } else if bindings.kind() == SyntaxKind::NamedImports {
                for item in bindings.elements() {
                    if item.is_type_only() {
                        continue;
                    }
                    let name = if item.property_name().is_nil() {
                        item.name()
                    } else {
                        item.property_name()
                    };
                    self.commonjs_alias(item.name(), index, Some(name.text().into()));
                }
            }
        }
        self.inventory_commonjs_export_demands(plan);
        Ok(diagnostics)
    }

    /// CommonJS executes every module wrapper, but a closed native program does
    /// not need to materialize an export that is never observed. Keep ordinary
    /// initialization effects and follow statically named re-exports; only the
    /// pure `exports.name = value` surface is eligible for pruning later.
    fn inventory_commonjs_export_demands(&mut self, plan: &modules::ModulePlan) {
        let mut aliases = HashMap::<u32, usize>::new();
        fn collect_aliases(
            lowerer: &mut Lowerer<'_>,
            node: Node,
            aliases: &mut HashMap<u32, usize>,
        ) {
            if node.kind() == SyntaxKind::CallExpression {
                let direct = lowerer
                    .commonjs
                    .requires
                    .get(&declarations::Key::of(node))
                    .copied();
                let wrapped_default = (node.expression().kind() == SyntaxKind::Identifier
                    && node.expression().text() == "__importDefault")
                    .then(|| node.arguments().into_iter().collect::<Vec<_>>())
                    .and_then(|arguments| match arguments.as_slice() {
                        [required] => lowerer
                            .commonjs
                            .requires
                            .get(&declarations::Key::of(*required))
                            .copied(),
                        _ => None,
                    });
                let Some(index) = direct.or(wrapped_default) else {
                    node.for_each_child(&mut |child| {
                        collect_aliases(lowerer, child, aliases);
                        false
                    });
                    return;
                };
                let parent = node.parent();
                if parent.kind() == SyntaxKind::VariableDeclaration
                    && parent.initializer() == node
                    && parent.name().kind() == SyntaxKind::Identifier
                {
                    let symbol = lowerer
                        .commonjs_lexical_symbol(parent.name())
                        .unwrap_or_else(|| {
                            lowerer.checker.get_symbol_at_location(parent.name(), false)
                        });
                    aliases.insert(symbol.0, index);
                }
            }
            node.for_each_child(&mut |child| {
                collect_aliases(lowerer, child, aliases);
                false
            });
        }
        for module in &plan.modules {
            collect_aliases(self, *module, &mut aliases);
        }

        for (index, key, _) in self.commonjs.imports.values() {
            if let Some(key) = key {
                self.commonjs
                    .demanded_exports
                    .entry(*index)
                    .or_default()
                    .insert(key.clone());
            } else {
                self.commonjs.all_exports_demanded.insert(*index);
            }
        }
        // The namespace shape of import(CJS) is observed after evaluation and
        // may include both `default` and statically detected named exports.
        // Retain the complete export surface until demand analysis models the
        // namespace record field-by-field.
        self.commonjs
            .all_exports_demanded
            .extend(self.commonjs.dynamic_imports.values().copied());

        fn export_assignment(statement: Node) -> Option<(String, Node)> {
            if statement.kind() != SyntaxKind::ExpressionStatement {
                return None;
            }
            let expression = statement.expression();
            if expression.kind() != SyntaxKind::BinaryExpression
                || expression.operator_token().kind() != SyntaxKind::EqualsToken
            {
                return None;
            }
            let left = expression.left();
            if left.kind() != SyntaxKind::PropertyAccessExpression
                || left.expression().kind() != SyntaxKind::Identifier
                || left.expression().text() != "exports"
                || left.name().kind() != SyntaxKind::Identifier
            {
                return None;
            }
            Some((left.name().text().to_string(), expression.right()))
        }

        fn scan(
            lowerer: &mut Lowerer<'_>,
            node: Node,
            owner: usize,
            export: Option<&str>,
            aliases: &HashMap<u32, usize>,
            edges: &mut Vec<ExportDemandEdge>,
        ) {
            let demand = |lowerer: &mut Lowerer<'_>,
                          target: usize,
                          member: Option<String>,
                          edges: &mut Vec<ExportDemandEdge>| {
                if let Some(export) = export {
                    edges.push(ExportDemandEdge {
                        owner,
                        export: export.to_string(),
                        target,
                        member,
                    });
                } else if let Some(member) = member {
                    lowerer
                        .commonjs
                        .demanded_exports
                        .entry(target)
                        .or_default()
                        .insert(member);
                } else {
                    lowerer.commonjs.all_exports_demanded.insert(target);
                }
            };

            // A required module object that escapes as a value (for example
            // `__importStar(require("./lib"))`) can be read under any key.
            if node.kind() == SyntaxKind::CallExpression
                && let Some(target) = lowerer
                    .commonjs
                    .requires
                    .get(&declarations::Key::of(node))
                    .copied()
            {
                let mut parent = node.parent();
                while parent.kind() == SyntaxKind::ParenthesizedExpression {
                    parent = parent.parent();
                }
                let member_receiver = matches!(
                    parent.kind(),
                    SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
                ) && primitives::primitive_source(parent.expression()) == node;
                let alias = parent.kind() == SyntaxKind::VariableDeclaration
                    && parent.name().kind() == SyntaxKind::Identifier;
                let default_wrapper = parent.kind() == SyntaxKind::CallExpression
                    && parent.expression().kind() == SyntaxKind::Identifier
                    && parent.expression().text() == "__importDefault";
                if !member_receiver && !alias && !default_wrapper {
                    demand(lowerer, target, None, edges);
                }
            }
            if matches!(
                node.kind(),
                SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
            ) {
                let receiver = node.expression();
                let target = if receiver.kind() == SyntaxKind::Identifier {
                    let symbol = lowerer
                        .commonjs_lexical_symbol(receiver)
                        .unwrap_or_else(|| lowerer.checker.get_symbol_at_location(receiver, false));
                    aliases.get(&symbol.0).copied()
                } else {
                    lowerer
                        .commonjs
                        .requires
                        .get(&declarations::Key::of(receiver))
                        .copied()
                };
                if let Some(target) = target {
                    let member = if node.kind() == SyntaxKind::PropertyAccessExpression {
                        (node.name().kind() == SyntaxKind::Identifier)
                            .then(|| node.name().text().to_string())
                    } else {
                        lowerer.literal_property_key(node.argument_expression())
                    };
                    demand(lowerer, target, member, edges);
                    return;
                }
            }
            if node.kind() == SyntaxKind::Identifier {
                let symbol = lowerer
                    .commonjs_lexical_symbol(node)
                    .unwrap_or_else(|| lowerer.checker.get_symbol_at_location(node, false));
                if let Some(target) = aliases.get(&symbol.0).copied() {
                    let parent = node.parent();
                    let declaration =
                        parent.kind() == SyntaxKind::VariableDeclaration && parent.name() == node;
                    if !declaration {
                        demand(lowerer, target, None, edges);
                    }
                    return;
                }
            }
            node.for_each_child(&mut |child| {
                scan(lowerer, child, owner, export, aliases, edges);
                false
            });
        }

        let mut edges = Vec::new();
        for (owner, instance) in self.commonjs.instances.clone().into_iter().enumerate() {
            if instance.json.is_some() {
                continue;
            }
            for statement in instance.file.statements() {
                if let Some((export, value)) = export_assignment(statement) {
                    scan(self, value, owner, Some(&export), &aliases, &mut edges);
                } else {
                    scan(self, statement, owner, None, &aliases, &mut edges);
                }
            }
        }
        loop {
            let mut changed = false;
            for edge in &edges {
                if !self.commonjs.all_exports_demanded.contains(&edge.owner)
                    && !self
                        .commonjs
                        .demanded_exports
                        .get(&edge.owner)
                        .is_some_and(|keys| keys.contains(&edge.export))
                {
                    continue;
                }
                if let Some(member) = &edge.member {
                    changed |= self
                        .commonjs
                        .demanded_exports
                        .entry(edge.target)
                        .or_default()
                        .insert(member.clone());
                } else {
                    changed |= self.commonjs.all_exports_demanded.insert(edge.target);
                }
            }
            if !changed {
                break;
            }
        }

        // A generated CommonJS bundle commonly decorates every exported
        // function (`fn.BREAK = ...`) before assigning it to `exports`. Those
        // writes would otherwise demand an unused function body. Prune only a
        // function whose complete source-file reference set is its declaration,
        // pure property scaffolding and direct, unobserved export assignments.
        for (index, instance) in self.commonjs.instances.clone().into_iter().enumerate() {
            if instance.json.is_some() || self.commonjs.all_exports_demanded.contains(&index) {
                continue;
            }
            for declaration in instance.file.statements() {
                if declaration.kind() != SyntaxKind::FunctionDeclaration
                    || declaration.name().kind() != SyntaxKind::Identifier
                {
                    continue;
                }
                let symbol = self.symbol(declaration.name());
                let mut exports = Vec::new();
                for statement in instance.file.statements() {
                    if let Some((key, value)) = export_assignment(statement)
                        && value.kind() == SyntaxKind::Identifier
                        && self.symbol(value) == symbol
                    {
                        exports.push(key);
                    }
                }
                if exports.is_empty()
                    || exports.iter().any(|key| {
                        self.commonjs
                            .demanded_exports
                            .get(&index)
                            .is_some_and(|keys| keys.contains(key))
                    })
                {
                    continue;
                }
                fn has_live_reference(lowerer: &mut Lowerer<'_>, node: Node, symbol: u32) -> bool {
                    if node.kind() == SyntaxKind::Identifier && lowerer.symbol(node) == symbol {
                        let parent = node.parent();
                        if parent.kind() == SyntaxKind::FunctionDeclaration && parent.name() == node
                        {
                            return false;
                        }
                        if parent.kind() == SyntaxKind::PropertyAccessExpression
                            && parent.name() == node
                        {
                            return false;
                        }
                        if parent.kind() == SyntaxKind::BinaryExpression
                            && parent.right() == node
                            && parent.operator_token().kind() == SyntaxKind::EqualsToken
                        {
                            let left = parent.left();
                            if left.kind() == SyntaxKind::PropertyAccessExpression
                                && left.expression().kind() == SyntaxKind::Identifier
                                && left.expression().text() == "exports"
                            {
                                return false;
                            }
                        }
                        if parent.kind() == SyntaxKind::PropertyAccessExpression
                            && parent.expression() == node
                        {
                            let assignment = parent.parent();
                            if assignment.kind() == SyntaxKind::BinaryExpression
                                && assignment.left() == parent
                                && assignment.operator_token().kind() == SyntaxKind::EqualsToken
                            {
                                return false;
                            }
                        }
                        return true;
                    }
                    let mut live = false;
                    node.for_each_child(&mut |child| {
                        live = has_live_reference(lowerer, child, symbol);
                        live
                    });
                    live
                }
                let live = has_live_reference(self, instance.file, symbol);
                if !live {
                    self.commonjs.pruned_export_functions.insert(symbol);
                }
            }
        }
    }

    fn commonjs_skip_export(&mut self, index: usize, statement: Node) -> bool {
        if self.commonjs.all_exports_demanded.contains(&index)
            || statement.kind() != SyntaxKind::ExpressionStatement
        {
            return false;
        }
        let expression = statement.expression();
        if expression.kind() != SyntaxKind::BinaryExpression
            || expression.operator_token().kind() != SyntaxKind::EqualsToken
        {
            return false;
        }
        let left = expression.left();
        let left_symbol = (left.kind() == SyntaxKind::PropertyAccessExpression
            && left.expression().kind() == SyntaxKind::Identifier)
            .then(|| self.symbol(left.expression()));
        if left.kind() == SyntaxKind::PropertyAccessExpression
            && left.expression().kind() == SyntaxKind::Identifier
            && left_symbol
                .is_some_and(|symbol| self.commonjs.pruned_export_functions.contains(&symbol))
        {
            return pure(expression.right());
        }
        if left.kind() != SyntaxKind::PropertyAccessExpression
            || left.expression().kind() != SyntaxKind::Identifier
            || left.expression().text() != "exports"
            || self
                .commonjs
                .demanded_exports
                .get(&index)
                .is_some_and(|keys| keys.contains(left.name().text()))
        {
            return false;
        }
        fn pure(node: Node) -> bool {
            match node.kind() {
                SyntaxKind::Identifier
                | SyntaxKind::StringLiteral
                | SyntaxKind::NumericLiteral
                | SyntaxKind::TrueKeyword
                | SyntaxKind::FalseKeyword
                | SyntaxKind::NullKeyword => true,
                SyntaxKind::PropertyAccessExpression => pure(node.expression()),
                SyntaxKind::ElementAccessExpression => {
                    pure(node.expression())
                        && matches!(
                            node.argument_expression().kind(),
                            SyntaxKind::StringLiteral | SyntaxKind::NumericLiteral
                        )
                }
                SyntaxKind::ParenthesizedExpression => pure(node.expression()),
                _ => false,
            }
        }
        pure(expression.right())
    }

    pub(super) fn json_import(&mut self, node: Node, file: &str) -> Result<(), String> {
        if node.kind() != SyntaxKind::ImportDeclaration {
            return Err(self.refuse(
                node,
                "JSON re-exports require an explicit module binding contract",
            ));
        }
        let clause = node.import_clause();
        if clause.is_nil() {
            return Ok(());
        }
        if clause.name().is_nil() || !clause.named_bindings().is_nil() {
            return Err(self.refuse(node, "only JSON default imports are ported"));
        }
        let index = *self
            .commonjs
            .files
            .get(file)
            .ok_or_else(|| self.refuse(node, "JSON import has no materialized module cache"))?;
        let name = clause.name();
        self.commonjs_alias(name, index, None);
        let symbol = self.checker.get_symbol_at_location(name, false).0;
        self.json_imports.insert(symbol);
        if matches!(
            self.commonjs.instances[index].json,
            Some(json_modules::DataValue::Object(_) | json_modules::DataValue::Array(_))
        ) {
            self.data_bindings.insert(symbol);
        }
        let source = self.checker.get_type_at_location(name);
        if self.checker.ty(source).flags.intersects(TypeFlags::OBJECT) {
            self.data_types.insert(source);
        }
        Ok(())
    }

    fn commonjs_alias(&mut self, node: Node, index: usize, key: Option<String>) {
        let symbol = self.checker.get_symbol_at_location(node, false).0;
        self.commonjs_alias_symbol(symbol, node.text(), index, key);
    }

    fn commonjs_alias_override(&mut self, node: Node, index: usize, key: Option<String>) {
        let symbol = self.checker.get_symbol_at_location(node, false).0;
        if let Some(existing) = self.commonjs.imports.get_mut(&symbol) {
            existing.0 = index;
            existing.1 = key;
            return;
        }
        self.commonjs_alias_symbol(symbol, node.text(), index, key);
    }

    fn commonjs_alias_symbol(
        &mut self,
        symbol: u32,
        name: &str,
        index: usize,
        key: Option<String>,
    ) {
        // Explicit named forwarding is visited before the star inventory and
        // wins on collisions. More importantly, never allocate an orphaned
        // global by replacing an already registered symbol entry.
        if self.commonjs.imports.contains_key(&symbol) {
            return;
        }
        let local = self.commonjs_global(name, Type::Dyn);
        self.commonjs.imports.insert(symbol, (index, key, local));
    }

    fn commonjs_import_symbol(&mut self, node: Node) -> Option<u32> {
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.checker.get_symbol_at_location(node, false);
        if self.commonjs.imports.contains_key(&symbol.0) {
            return Some(symbol.0);
        }
        // Preserve an ESM barrel's rename before asking the checker for the
        // final CommonJS assignment symbol. Fully resolving the alias would
        // otherwise make both `add` and `export { add as plus }` read `add`.
        if symbol.0 != 0 {
            let metadata = self.checker.sym(symbol);
            let declaration = if metadata.value_declaration.is_nil() {
                metadata.declarations.first().copied().unwrap_or(Node::NIL)
            } else {
                metadata.value_declaration
            };
            let imported = if declaration.is_nil() {
                None
            } else {
                match declaration.kind() {
                    SyntaxKind::ImportSpecifier => Some(declaration.property_name_or_name().text()),
                    SyntaxKind::ImportClause if declaration.name() == node => Some("default"),
                    _ => None,
                }
            };
            if let Some(imported) = imported {
                let mut owner = declaration;
                while !owner.is_nil() && owner.kind() != SyntaxKind::ImportDeclaration {
                    owner = owner.parent();
                }
                if !owner.is_nil() {
                    let specifier = owner.module_specifier();
                    if let Some(resolution) = program::get_resolved_module_from_module_specifier(
                        get_source_file_of_node(owner),
                        specifier,
                    ) {
                        let file = program::get_source_file_for_resolved_module(&resolution);
                        if !file.is_nil()
                            && let Some(exported) = self
                                .checker
                                .get_exports_of_module_as_array(file.symbol())
                                .into_iter()
                                .find(|exported| {
                                    self.checker.sym(*exported).name.as_ref() == imported
                                })
                            && self.commonjs.imports.contains_key(&exported.0)
                        {
                            return Some(exported.0);
                        }
                    }
                }
            }
        }
        if symbol.0 != 0
            && self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
        {
            let target = self.checker.get_aliased_symbol(symbol).0;
            if self.commonjs.imports.contains_key(&target) {
                return Some(target);
            }
        }
        None
    }

    pub(super) fn json_import_type(&mut self, node: Node) -> Option<Type> {
        let (index, key) = self.commonjs_import(node)?;
        let symbol = self.checker.get_symbol_at_location(node, false).0;
        if key.is_some() || !self.json_imports.contains(&symbol) {
            return None;
        }
        Some(match self.commonjs.instances[index].json.as_ref()? {
            json_modules::DataValue::Number(_) => Type::F64,
            json_modules::DataValue::String(_) => Type::String,
            json_modules::DataValue::Bool(_) => Type::Bool,
            _ => Type::Dyn,
        })
    }

    pub(super) fn commonjs_import(&mut self, node: Node) -> Option<(usize, Option<String>)> {
        let symbol = self.commonjs_import_symbol(node)?;
        self.commonjs
            .imports
            .get(&symbol)
            .map(|(i, key, _)| (*i, key.clone()))
    }

    /// A direct `const ns = require("...")` binding is a statically linked
    /// module export object. Class heritage may use a named data export from
    /// this namespace without treating the receiver as an arbitrary effectful
    /// expression; the require itself still executes at its source site.
    pub(super) fn commonjs_namespace_alias(&mut self, node: Node) -> bool {
        self.commonjs_namespace_require_file(node).is_some()
    }

    /// Resolve the require owned by a namespace binding, including the
    /// canonical TypeScript `__importDefault(require(...))` wrapper.
    pub(super) fn commonjs_namespace_require_file(&mut self, node: Node) -> Option<Node> {
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let required = |this: &Self, declaration: Node| -> Option<Node> {
            if declaration.is_nil() || declaration.kind() != SyntaxKind::VariableDeclaration {
                return None;
            }
            let mut value = declaration.initializer();
            while !value.is_nil() && value.kind() == SyntaxKind::ParenthesizedExpression {
                value = value.expression();
            }
            if value.is_nil() {
                return None;
            }
            if this
                .commonjs
                .requires
                .contains_key(&declarations::Key::of(value))
            {
                return this.commonjs_require_file(value);
            }
            if value.kind() != SyntaxKind::CallExpression
                || value.expression().kind() != SyntaxKind::Identifier
                || value.expression().text() != "__importDefault"
            {
                return None;
            }
            let arguments = value.arguments().into_iter().collect::<Vec<_>>();
            let [required] = arguments.as_slice() else {
                return None;
            };
            this.commonjs_require_file(*required)
        };
        let symbol = self
            .commonjs_lexical_symbol(node)
            .unwrap_or_else(|| self.checker.get_symbol_at_location(node, false));
        if symbol.0 != 0
            && let Some(file) = required(self, self.checker.sym(symbol).value_declaration)
        {
            return Some(file);
        }
        // JavaScript checker aliases can resolve the use to an exported type
        // rather than the lexical `var` declaration. Retain the syntactic
        // top-level binding as the authoritative require site in that case.
        get_source_file_of_node(node)
            .statements()
            .into_iter()
            .find_map(|statement| {
                if statement.kind() != SyntaxKind::VariableStatement {
                    return None;
                }
                statement
                    .declaration_list()
                    .declarations()
                    .nodes()
                    .into_iter()
                    .find_map(|declaration| {
                        if declaration.name().kind() == SyntaxKind::Identifier
                            && declaration.name().text() == node.text()
                        {
                            required(self, declaration)
                        } else {
                            None
                        }
                    })
            })
    }

    pub(super) fn commonjs_binding(&mut self, node: Node) -> Option<Local> {
        if node.kind() != SyntaxKind::Identifier
            || !matches!(node.text(), "exports" | "module")
            || !ambient(self.checker, node)
        {
            return None;
        }
        let index = *self.commonjs.files.get(&self.file)?;
        let instance = &self.commonjs.instances[index];
        Some(if node.text() == "exports" {
            instance.exports.clone()
        } else {
            instance.module.clone()
        })
    }

    pub(super) fn commonjs_module_logical_storage(&mut self, node: Node) -> Option<Type> {
        if node.is_nil() {
            return None;
        }
        fn flatten_and(node: Node, terms: &mut Vec<Node>) {
            let node = primitives::primitive_source(node);
            if node.kind() == SyntaxKind::BinaryExpression
                && node.operator_token().kind() == SyntaxKind::AmpersandAmpersandToken
            {
                flatten_and(node.left(), terms);
                flatten_and(node.right(), terms);
            } else {
                terms.push(node);
            }
        }
        let mut terms = Vec::new();
        flatten_and(node, &mut terms);
        if terms.len() < 2 {
            return None;
        }
        let module_term = *terms.last()?;
        let module = self.commonjs_binding(module_term)?;
        if module_term.text() != "module"
            || !terms[..terms.len() - 1].iter().all(|term| {
                self.commonjs_binding(*term)
                    .is_some_and(|binding| binding.id == module.id)
                    || (term.kind() == SyntaxKind::BinaryExpression
                        && matches!(
                            term.operator_token().kind(),
                            SyntaxKind::EqualsEqualsToken
                                | SyntaxKind::EqualsEqualsEqualsToken
                                | SyntaxKind::ExclamationEqualsToken
                                | SyntaxKind::ExclamationEqualsEqualsToken
                        ))
            })
        {
            return None;
        }
        // The source-level NodeModule surface is broader than the compiler's
        // owning CommonJS cell (which deliberately stores only `exports`).
        // Keep aliases to the guarded module value erased so later member
        // access observes that owning cell instead of projecting it into a
        // checker-only structural record.
        Some(Type::Dyn)
    }

    fn commonjs_read(&self, local: &Local, node: Node) -> Expr {
        Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        }
    }

    pub(super) fn commonjs_this(&self, node: Node) -> Option<Expr> {
        let index = *self.commonjs.files.get(&self.file)?;
        Some(self.commonjs_read(&self.commonjs.instances[index].exports, node))
    }

    fn commonjs_exports(&self, index: usize, node: Node) -> Expr {
        let module = &self.commonjs.instances[index].module;
        let Type::Record { shape_id } = module.r#type else {
            unreachable!()
        };
        Expr::RecordGet {
            obj: Box::new(self.commonjs_read(module, node)),
            shape_id: format!("r{shape_id}"),
            field: "exports".into(),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }
    }

    pub(super) fn commonjs_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if let Some(module) = self
            .native_require_calls
            .get(&declarations::Key::of(node))
            .copied()
        {
            return Ok(Some(self.native_module_namespace_value(node, module)?));
        }
        if let Some(binding) = self.commonjs_binding(node) {
            return Ok(Some(self.commonjs_read(&binding, node)));
        }
        if let Some((_, key)) = self.commonjs_import(node) {
            let symbol = self
                .commonjs_import_symbol(node)
                .expect("CommonJS import was resolved above");
            let local = self.commonjs.imports[&symbol].2.clone();
            let value = self.commonjs_read(&local, node);
            let value = if key.is_some() || self.json_imports.contains(&symbol) {
                let target = self.ty(node)?;
                if matches!(
                    target,
                    Type::F64
                        | Type::String
                        | Type::Bool
                        | Type::Func { .. }
                        | Type::Classval { .. }
                ) {
                    self.coerce(value, target, node)?
                } else {
                    value
                }
            } else {
                value
            };
            return Ok(Some(value));
        }
        if let Some(index) = self.commonjs.requires.get(&declarations::Key::of(node)) {
            return Ok(Some(self.commonjs_call(*index, node)));
        }
        if let Some(specifier) = self
            .commonjs
            .missing_requires
            .get(&declarations::Key::of(node))
            .copied()
        {
            return Ok(Some(Expr::Intrinsic {
                name: "module.require.missing".into(),
                args: vec![self.expected_expression(specifier, Type::String)?],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        if let Some(target) = self
            .commonjs
            .esm_requires
            .get(&declarations::Key::of(node))
            .copied()
        {
            let path = source_file_info(target).file_name.to_string();
            let namespace = self.namespace_value_for_file(target, node);
            let Some(initializer) = self.lazy_modules.get(&path).cloned() else {
                return Ok(Some(namespace));
            };
            let r#type = namespace.ty();
            return Ok(Some(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: Expr::Call {
                        callee: initializer,
                        args: vec![],
                        r#type: Type::Void,
                        loc: self.loc(node),
                    },
                    loc: self.loc(node),
                }],
                result: Box::new(namespace),
                r#type,
                loc: self.loc(node),
            }));
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.expression().kind() == SyntaxKind::Identifier
            && node.expression().text() == "require"
            && ambient(self.checker, node.expression())
        {
            return Err(self.refuse(node, "lazy or dynamic CommonJS require is not ported"));
        }
        Ok(None)
    }

    pub(super) fn commonjs_snapshots(&self, index: usize, node: Node) -> Vec<Stmt> {
        // Hash maps are lookup tables, never evaluation-order sources.
        let mut imports = self
            .commonjs
            .imports
            .values()
            .filter(|(i, _, _)| *i == index)
            .collect::<Vec<_>>();
        imports.sort_by(|a, b| a.2.id.cmp(&b.2.id));
        imports
            .into_iter()
            .map(|(_, key, local)| {
                let value = self.commonjs_exports(index, node);
                let value = if let Some(key) = key {
                    self.dynamic_get(
                        node,
                        value,
                        Expr::StrLit {
                            value: key.clone(),
                            r#type: Type::String,
                            loc: self.loc(node),
                        },
                    )
                } else {
                    value
                };
                Stmt::Assign {
                    local_id: local.id.clone(),
                    initializes_global: false,
                    value,
                    loc: self.loc(node),
                }
            })
            .collect()
    }

    pub(super) fn commonjs_call(&self, index: usize, node: Node) -> Expr {
        Expr::Call {
            callee: self.commonjs.instances[index].name.clone(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }
    }

    pub(super) fn commonjs_file_index(&self, path: &str) -> Option<usize> {
        self.commonjs.files.get(path).copied()
    }

    pub(super) fn commonjs_dynamic_import_index(&self, node: Node) -> Option<usize> {
        self.commonjs
            .dynamic_imports
            .get(&declarations::Key::of(node))
            .copied()
    }

    pub(super) fn commonjs_exports_value(&self, index: usize, node: Node) -> Expr {
        self.commonjs_exports(index, node)
    }

    pub(super) fn commonjs_initializer_closure(&self, index: usize, node: Node) -> Expr {
        Expr::Closure {
            fn_name: self.commonjs.instances[index].name.clone(),
            captures: vec![],
            r#type: Type::Func {
                rest: false,
                params: vec![],
                ret: Box::new(Type::Dyn),
            },
            loc: self.loc(node),
        }
    }

    pub(super) fn commonjs_index(&self, file: Node) -> Option<usize> {
        self.commonjs
            .files
            .get(&source_file_info(file).file_name.to_string())
            .copied()
    }

    pub(super) fn commonjs_prelude(&self) -> Vec<Stmt> {
        let mut prelude = self
            .commonjs
            .instances
            .iter()
            .map(|m| Stmt::Assign {
                local_id: m.started.id.clone(),
                initializes_global: true,
                value: Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: self.loc(m.file),
                },
                loc: self.loc(m.file),
            })
            .collect::<Vec<_>>();
        // Import aliases are mutable snapshot cells. They exist before any
        // CommonJS/JSON module executes (including modules retained only for
        // type/layout inventory), then `commonjs_snapshots` publishes the live
        // export after evaluation. Give every cell exactly one initializer so
        // cycles observe JavaScript's pre-evaluation `undefined` rather than an
        // invalid native global with no storage.
        let mut aliases = self
            .commonjs
            .imports
            .values()
            .map(|(_, _, local)| local)
            .collect::<Vec<_>>();
        aliases.sort_by(|left, right| left.id.cmp(&right.id));
        prelude.extend(aliases.into_iter().map(|local| {
            let loc = Loc {
                file: local.name.clone(),
                start: 0,
                end: 0,
            };
            Stmt::Assign {
                local_id: local.id.clone(),
                initializes_global: true,
                value: Expr::DynFrom {
                    value: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: loc.clone(),
                    }),
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc,
            }
        }));
        prelude
    }

    pub(super) fn lower_commonjs(&mut self) -> Result<Vec<Function>, String> {
        self.lower_commonjs_selected(None)
    }

    pub(super) fn lower_commonjs_selected(
        &mut self,
        selected: Option<Node>,
    ) -> Result<Vec<Function>, String> {
        let mut functions = Vec::new();
        for (index, instance) in self.commonjs.instances.clone().into_iter().enumerate() {
            if selected.is_some_and(|file| file != instance.file) {
                continue;
            }
            self.file = source_file_info(instance.file).file_name.to_string();
            if std::env::var_os("SCRIPTC_TRACE_FUNCTIONS").is_some() {
                eprintln!("scriptc: lowering CommonJS module {}", self.file);
            }
            self.locals.clear();
            self.bindings.clear();
            self.var_defined.clear();
            let loc = self.loc(instance.file);
            let Type::Record { shape_id } = instance.module.r#type else {
                unreachable!()
            };
            let mut body = vec![Stmt::If {
                cond: self.commonjs_read(&instance.started, instance.file),
                then: vec![Stmt::Return {
                    value: Some(self.commonjs_exports(index, instance.file)),
                    loc: loc.clone(),
                }],
                else_: None,
                loc: loc.clone(),
            }];
            let initial_exports = if let Some(value) = &instance.json {
                self.json_module_value(instance.file, value)?
            } else {
                Expr::DynObjLit {
                    fields: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                }
            };
            body.push(Stmt::Assign {
                local_id: instance.module.id.clone(),
                initializes_global: true,
                value: Expr::RecordLit {
                    null_prototype: false,
                    fields: vec![ir::FieldInit {
                        name: "exports".into(),
                        value: initial_exports,
                        absent: false,
                        overflow: false,
                    }],
                    r#type: Type::Record { shape_id },
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            });
            body.push(Stmt::Assign {
                local_id: instance.exports.id.clone(),
                initializes_global: true,
                value: self.commonjs_exports(index, instance.file),
                loc: loc.clone(),
            });
            body.push(Stmt::Assign {
                local_id: instance.started.id.clone(),
                initializes_global: false,
                value: Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            });
            if instance.json.is_none() {
                for statement in instance.file.statements() {
                    if !self.commonjs_skip_export(index, statement) {
                        body.extend(self.statement(statement)?);
                    }
                }
            }
            body.push(Stmt::Return {
                value: Some(self.commonjs_exports(index, instance.file)),
                loc: loc.clone(),
            });
            functions.push(Function {
                is_async: false,
                generator: None,
                rest: false,
                name: instance.name,
                params: vec![],
                captures: None,
                return_type: Type::Dyn,
                locals: std::mem::take(&mut self.locals),
                body,
                loc,
            });
        }
        Ok(functions)
    }

    /// `module.createRequire(base)` evaluates its base location and returns a
    /// native require function. A compiled binary has no run-time module
    /// loader, so every call reports MODULE_NOT_FOUND for its specifier after
    /// evaluating it, exactly as Node does for a missing target. Statically
    /// linked `require()` sites keep their ordinary CommonJS lowering.
    pub(super) fn module_create_require(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 {
            return Err(self.refuse(node, "module.createRequire requires exactly one base location"));
        }
        self.ensure_exception_classes(node)?;
        let base = self.expression(arguments[0])?;
        let loc = self.loc(node);
        let mut helper = helpers::Helper::new(
            "native_module_create_require_value",
            vec![Type::String],
            Type::Dyn,
            loc.clone(),
        );
        let specifier = helper.read(&helper.param(0));
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::Intrinsic {
                name: "module.require.missing".into(),
                args: vec![specifier],
                r#type: Type::Dyn,
                loc: loc.clone(),
            }),
            loc: loc.clone(),
        });
        let r#type = Type::Func {
            params: vec![Type::String],
            ret: Box::new(Type::Dyn),
            rest: false,
        };
        let closure = Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: r#type.clone(),
            loc: loc.clone(),
        };
        Ok(Expr::Sequence {
            stmts: vec![Stmt::Expression { expr: base, loc: loc.clone() }],
            result: Box::new(closure),
            r#type,
            loc,
        })
    }
}
