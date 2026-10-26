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
) -> Result<(), String> {
    fn visit(
        checker: &mut Checker,
        node: Node,
        out: &mut Vec<(Node, Node)>,
        direct: bool,
    ) -> Result<(), String> {
        if node.kind() == SyntaxKind::VariableDeclaration
            && node.parent().kind() == SyntaxKind::VariableDeclarationList
            && node.name().kind() == SyntaxKind::Identifier
            && matches!(node.name().text(), "exports" | "module" | "require")
            && (!node
                .parent()
                .flags()
                .intersects(NodeFlags::LET | NodeFlags::CONST)
                || node.parent().parent().parent().kind() == SyntaxKind::SourceFile)
        {
            let file = get_source_file_of_node(node);
            if is_module(file) {
                return Err(refusal(
                    &source_file_info(file).file_name,
                    node,
                    "CommonJS wrapper binding declarations are not ported",
                ));
            }
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.expression().kind() == SyntaxKind::Identifier
            && node.expression().text() == "require"
            && ambient(checker, node.expression())
        {
            let file = get_source_file_of_node(node);
            if !is_module(file) {
                return Err(refusal(
                    &source_file_info(file).file_name,
                    node,
                    "ambient require is unavailable in an ES module",
                ));
            }
            let args = node.arguments();
            if !direct || args.len() != 1 || args.get(0).kind() != SyntaxKind::StringLiteral {
                return Err(refusal(
                    &source_file_info(get_source_file_of_node(node)).file_name,
                    node,
                    "CommonJS requires a literal request in supported module initialization",
                ));
            }
            out.push((node, args.get(0)));
        }
        if matches!(
            node.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
        ) {
            return Ok(());
        }
        let direct = direct
            && !matches!(
                node.kind(),
                SyntaxKind::ConditionalExpression
                    | SyntaxKind::WhileStatement
                    | SyntaxKind::DoStatement
                    | SyntaxKind::ForStatement
                    | SyntaxKind::ForInStatement
                    | SyntaxKind::ForOfStatement
                    | SyntaxKind::TryStatement
            )
            && (node.kind() != SyntaxKind::BinaryExpression
                || node.operator_token().kind() == SyntaxKind::EqualsToken);
        let mut result = Ok(());
        node.for_each_child(&mut |child| {
            result = visit(checker, child, out, direct);
            result.is_err()
        });
        result
    }
    visit(checker, file, out, true)
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

#[derive(Default)]
pub(super) struct Graph {
    instances: Vec<Instance>,
    files: HashMap<String, usize>,
    pub(super) requires: HashMap<declarations::Key, usize>,
    pub(super) local_symbols: HashSet<u32>,
    pub(super) native_declarations: HashSet<declarations::Key>,
    imports: HashMap<u32, (usize, Option<String>, Local)>,
}

impl Lowerer<'_> {
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
        });
        local
    }

    pub(super) fn inventory_commonjs(&mut self, plan: &modules::ModulePlan) -> Result<(), String> {
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
                return Err(refusal(
                    &source_file_info(source_frontend::prelude::get_source_file_of_node(*node))
                        .file_name,
                    *node,
                    "CommonJS namespace import snapshots are not ported",
                ));
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
        Ok(())
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
        let local = self.commonjs_global(node.text(), Type::Dyn);
        self.commonjs.imports.insert(symbol, (index, key, local));
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
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.checker.get_symbol_at_location(node, false).0;
        self.commonjs
            .imports
            .get(&symbol)
            .map(|(i, key, _)| (*i, key.clone()))
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

    fn commonjs_read(&self, local: &Local, node: Node) -> Expr {
        Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        }
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
        if let Some(binding) = self.commonjs_binding(node) {
            return Ok(Some(self.commonjs_read(&binding, node)));
        }
        if let Some((_, key)) = self.commonjs_import(node) {
            let symbol = self.checker.get_symbol_at_location(node, false).0;
            let local = self.commonjs.imports[&symbol].2.clone();
            let value = self.commonjs_read(&local, node);
            let value = if key.is_some() || self.json_imports.contains(&symbol) {
                let target = self.ty(node)?;
                if matches!(
                    target,
                    Type::F64 | Type::String | Type::Bool | Type::Func { .. }
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
                    initializes_global: true,
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

    pub(super) fn commonjs_index(&self, file: Node) -> Option<usize> {
        self.commonjs
            .files
            .get(&source_file_info(file).file_name.to_string())
            .copied()
    }

    pub(super) fn commonjs_prelude(&self) -> Vec<Stmt> {
        self.commonjs
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
            .collect()
    }

    pub(super) fn lower_commonjs(&mut self) -> Result<Vec<Function>, String> {
        let mut functions = Vec::new();
        for (index, instance) in self.commonjs.instances.clone().into_iter().enumerate() {
            self.file = source_file_info(instance.file).file_name.to_string();
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
                body.extend(self.statements(instance.file.statements())?);
            }
            body.push(Stmt::Return {
                value: Some(self.commonjs_exports(index, instance.file)),
                loc: loc.clone(),
            });
            functions.push(Function {
                is_async: false,
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
}
