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
                    "CommonJS requires a literal request in unconditional module initialization",
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
                SyntaxKind::IfStatement
                    | SyntaxKind::ConditionalExpression
                    | SyntaxKind::BinaryExpression
                    | SyntaxKind::WhileStatement
                    | SyntaxKind::ForStatement
                    | SyntaxKind::TryStatement
            );
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
        for file in &plan.modules {
            if !is_module(*file) {
                continue;
            }
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
                .insert(source_file_info(*file).file_name.to_string(), index);
            self.commonjs.instances.push(Instance {
                file: *file,
                module,
                exports,
                started,
                name: format!("cjs{index}"),
            });
        }
        for (site, target) in &plan.requires {
            let index = self.commonjs.files[&source_file_info(*target).file_name.to_string()];
            self.commonjs.requires.insert(site.clone(), index);
        }
        for file in &plan.modules {
            self.file = source_file_info(*file).file_name.to_string();
            fn bindings(lowerer: &mut Lowerer<'_>, node: Node) {
                if node.kind() == SyntaxKind::VariableDeclaration
                    && node.name().kind() == SyntaxKind::Identifier
                    && !node.initializer().is_nil()
                    && (lowerer
                        .commonjs
                        .requires
                        .contains_key(&declarations::Key::of(node.initializer()))
                        || lowerer.commonjs_binding(node.initializer()).is_some())
                {
                    let symbol = lowerer.checker.get_symbol_at_location(node.name(), false).0;
                    lowerer.commonjs.local_symbols.insert(symbol);
                    lowerer.data_bindings.insert(symbol);
                }
                node.for_each_child(&mut |child| {
                    bindings(lowerer, child);
                    false
                });
            }
            bindings(self, *file);
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

    fn commonjs_alias(&mut self, node: Node, index: usize, key: Option<String>) {
        let symbol = self.checker.get_symbol_at_location(node, false).0;
        let local = self.commonjs_global(node.text(), Type::Dyn);
        self.commonjs.imports.insert(symbol, (index, key, local));
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
            let value = if key.is_some() {
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
            body.push(Stmt::Assign {
                local_id: instance.module.id.clone(),
                initializes_global: true,
                value: Expr::RecordLit {
                    fields: vec![ir::FieldInit {
                        name: "exports".into(),
                        value: Expr::DynObjLit {
                            fields: vec![],
                            r#type: Type::Dyn,
                            loc: loc.clone(),
                        },
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
            body.extend(self.statements(instance.file.statements())?);
            body.push(Stmt::Return {
                value: Some(self.commonjs_exports(index, instance.file)),
                loc: loc.clone(),
            });
            functions.push(Function {
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
