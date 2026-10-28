//! Resolve executable modules before lowering. This phase never drops initializers.
use super::*;

pub(super) struct ModulePlan {
    pub modules: Vec<Node>,
    pub execution_order: Vec<Node>,
    pub bindings: Vec<ImportBinding>,
    pub requires: HashMap<declarations::Key, Node>,
}

/// An unobserved default expression still runs at its source position. Keep
/// the snapshot binding refused whenever any reachable import or re-export can
/// observe it, until default-export cells have their own module storage.
pub(super) fn unobserved_defaults(
    checker: &mut Checker,
    files: &[Node],
) -> HashSet<declarations::Key> {
    let mut defaults = HashMap::new();
    for file in files {
        for node in file.statements() {
            if node.kind() == SyntaxKind::ExportAssignment && !node.is_export_equals() {
                defaults.insert(source_file_info(*file).file_name.to_string(), node);
            }
        }
    }
    let mut observed = HashSet::new();
    for file in files {
        for node in file.statements() {
            let Some(specifier) = runtime_specifier(node) else {
                continue;
            };
            let symbol = checker.get_symbol_at_location(specifier, false);
            if symbol.0 == 0 {
                continue;
            }
            let target = checker.sym(symbol).value_declaration;
            if target.is_nil() || target.kind() != SyntaxKind::SourceFile {
                continue;
            }
            let path = source_file_info(target).file_name.to_string();
            if !defaults.contains_key(&path) {
                continue;
            }
            let observes = if node.kind() == SyntaxKind::ImportDeclaration {
                let clause = node.import_clause();
                if clause.is_nil() {
                    false
                } else {
                    let bindings = clause.named_bindings();
                    !clause.name().is_nil()
                        || (!bindings.is_nil()
                            && (bindings.kind() == SyntaxKind::NamespaceImport
                                || (bindings.kind() == SyntaxKind::NamedImports
                                    && bindings.elements().into_iter().any(|item| {
                                        !item.is_type_only()
                                            && item.property_name_or_name().text() == "default"
                                    }))))
                }
            } else {
                let clause = node.export_clause();
                !clause.is_nil()
                    && (clause.kind() != SyntaxKind::NamedExports
                        || clause.elements().into_iter().any(|item| {
                            !item.is_type_only() && item.property_name_or_name().text() == "default"
                        }))
            };
            if observes {
                observed.insert(path);
            }
        }
    }
    defaults
        .into_iter()
        .filter_map(|(path, node)| (!observed.contains(&path)).then(|| declarations::Key::of(node)))
        .collect()
}

pub(super) enum ImportBinding {
    NativeRequire {
        name: Node,
        module: &'static str,
    },
    CommonJs {
        node: Node,
        target: Node,
    },
    Native {
        node: Node,
        module: &'static str,
        file: String,
    },
    Json {
        node: Node,
        path: String,
        file: String,
    },
}

// A whole type-only declaration is erased. Inline type specifiers can leave
// an empty runtime import/export, so keep their module evaluation edge.
pub(super) fn runtime_specifier(node: Node) -> Option<Node> {
    if !matches!(
        node.kind(),
        SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration
    ) || node.is_type_only()
    {
        return None;
    }
    if node.kind() == SyntaxKind::ImportDeclaration {
        let clause = node.import_clause();
        if !clause.is_nil() && clause.is_type_only() {
            return None;
        }
    }
    let specifier = node.module_specifier();
    (!specifier.is_nil()).then_some(specifier)
}

impl ModulePlan {
    pub(super) fn link(checker: &mut Checker, entry: Node) -> Result<Self, String> {
        let mut plan = Self {
            modules: Vec::new(),
            execution_order: Vec::new(),
            bindings: Vec::new(),
            requires: HashMap::new(),
        };
        plan.visit(checker, entry, &mut HashSet::new(), &mut HashSet::new())?;
        plan.schedule(checker, entry, &mut HashSet::new());
        Ok(plan)
    }

    fn schedule(&mut self, checker: &mut Checker, file: Node, visited: &mut HashSet<String>) {
        let path = source_file_info(file).file_name.to_string();
        if !visited.insert(path) {
            return;
        }
        if !commonjs::is_module(file) {
            for node in file.statements() {
                let Some(specifier) = runtime_specifier(node) else {
                    continue;
                };
                if builtins::module(specifier.text()).is_some() {
                    continue;
                }
                let symbol = checker.get_symbol_at_location(specifier, false);
                if symbol.0 == 0 {
                    continue;
                }
                let target = checker.sym(symbol).value_declaration;
                if !target.is_nil() && target.kind() == SyntaxKind::SourceFile {
                    self.schedule(checker, target, visited);
                }
            }
        }
        self.execution_order.push(file);
    }

    fn visit(
        &mut self,
        checker: &mut Checker,
        file: Node,
        active: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> Result<(), String> {
        let path = source_file_info(file).file_name.to_string();
        if visited.contains(&path) || !active.insert(path.clone()) {
            return Ok(());
        }
        for node in file.statements() {
            let Some(specifier) = runtime_specifier(node) else {
                continue;
            };
            if let Some(module) = builtins::module(specifier.text()) {
                self.bindings.push(ImportBinding::Native {
                    node,
                    module,
                    file: path.clone(),
                });
                continue;
            }
            let symbol = checker.get_symbol_at_location(specifier, false);
            if symbol.0 == 0 {
                return Err(refusal(
                    &path,
                    node,
                    &format!(
                        "Rust frontend did not resolve runtime module '{}'",
                        specifier.text()
                    ),
                ));
            }
            let target = checker.sym(symbol).value_declaration;
            if target.is_nil() || target.kind() != SyntaxKind::SourceFile {
                return Err(refusal(
                    &path,
                    node,
                    &format!(
                        "import '{}' has no executable source module",
                        specifier.text()
                    ),
                ));
            }
            let target_path = source_file_info(target).file_name.to_string();
            if target_path.ends_with(".json") {
                self.bindings.push(ImportBinding::Json {
                    node,
                    path: target_path,
                    file: path.clone(),
                });
                continue;
            }
            if is_declaration(&target_path)
                || ![".ts", ".mts", ".js", ".mjs", ".cjs"]
                    .iter()
                    .any(|suffix| target_path.ends_with(suffix))
            {
                return Err(refusal(
                    &path,
                    node,
                    &format!(
                        "import '{}' resolves to unsupported runtime source '{target_path}'",
                        specifier.text()
                    ),
                ));
            }
            if commonjs::is_module(target) {
                if node.kind() != SyntaxKind::ImportDeclaration {
                    return Err(refusal(&path, node, "CommonJS re-exports are not ported"));
                }
                self.bindings.push(ImportBinding::CommonJs { node, target });
            }
            self.visit(checker, target, active, visited)?;
        }
        let mut calls = Vec::new();
        commonjs::require_calls(checker, file, &mut calls)?;
        for (call, specifier) in calls {
            if let Some(module) = builtins::module(specifier.text()) {
                let declaration = call.parent();
                if declaration.kind() != SyntaxKind::VariableDeclaration
                    || declaration.name().kind() != SyntaxKind::Identifier
                    || declaration.parent().parent().parent().kind() != SyntaxKind::SourceFile
                {
                    return Err(refusal(
                        &path,
                        call,
                        "native require needs an unconditional module-level identifier namespace binding",
                    ));
                }
                self.bindings.push(ImportBinding::NativeRequire {
                    name: declaration.name(),
                    module,
                });
                continue;
            }
            // Assignment RHS requests need not have a declaration symbol at
            // their string literal. Use the program's resolved module graph.
            let target = program::get_resolved_module_from_module_specifier(file, specifier)
                .map(|resolved| program::get_source_file_for_resolved_module(&resolved))
                .unwrap_or(Node::NIL);
            if target.is_nil()
                || target.kind() != SyntaxKind::SourceFile
                || (!source_file_info(target).file_name.ends_with(".json")
                    && !commonjs::is_module(target))
            {
                return Err(refusal(
                    &path,
                    call,
                    "require currently needs a source CommonJS module",
                ));
            }
            self.requires.insert(declarations::Key::of(call), target);
            if !source_file_info(target).file_name.ends_with(".json") {
                self.visit(checker, target, active, visited)?;
            }
        }
        active.remove(&path);
        visited.insert(path);
        self.modules.push(file);
        Ok(())
    }
}
