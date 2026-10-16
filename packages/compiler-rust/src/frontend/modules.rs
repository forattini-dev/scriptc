//! Resolve executable modules before lowering. This phase never drops initializers.
use super::*;

pub(super) struct ModulePlan {
    pub evaluation_order: Vec<Node>,
    pub bindings: Vec<ImportBinding>,
}

pub(super) enum ImportBinding {
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
            evaluation_order: Vec::new(),
            bindings: Vec::new(),
        };
        plan.visit(checker, entry, &mut HashSet::new(), &mut HashSet::new())?;
        Ok(plan)
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
                || ![".ts", ".mts", ".js", ".mjs"]
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
            self.visit(checker, target, active, visited)?;
        }
        active.remove(&path);
        visited.insert(path);
        self.evaluation_order.push(file);
        Ok(())
    }
}
