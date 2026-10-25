//! Plan local JavaScript input slots before caching callable/storage layouts.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

pub(super) fn is_javascript(node: Node) -> bool {
    let file = source_file_info(get_source_file_of_node(node));
    [".js", ".mjs", ".cjs"]
        .iter()
        .any(|ext| file.file_name.ends_with(ext))
}

fn collect(node: Node, functions: &mut Vec<Node>, calls: &mut Vec<Node>) {
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
    ) {
        functions.push(node);
    }
    if node.kind() == SyntaxKind::CallExpression {
        calls.push(node);
    }
    node.for_each_child(&mut |child| {
        collect(child, functions, calls);
        false
    });
}

impl Lowerer<'_> {
    pub(super) fn plan_parameter_abi(&mut self, files: &[Node]) {
        let mut functions = Vec::new();
        let mut calls = Vec::new();
        for file in files {
            collect(*file, &mut functions, &mut calls);
        }
        let mut targets = HashMap::new();
        for function in functions {
            if !is_javascript(function) || self.declared(function).is_some() {
                continue;
            }
            let binding = if function.kind() == SyntaxKind::FunctionDeclaration {
                function.name()
            } else if function.parent().kind() == SyntaxKind::VariableDeclaration {
                let declaration = function.parent();
                if self.declared(declaration).is_some() {
                    continue;
                }
                declaration.name()
            } else {
                continue;
            };
            if binding.is_nil() || binding.kind() != SyntaxKind::Identifier {
                continue;
            }
            let symbol = self.symbol(binding);
            if symbol != 0 {
                targets.insert(symbol, receivers::parameters(function));
            }
        }
        if targets.is_empty() {
            return;
        }
        let mut edges = Vec::new();
        for call in calls {
            let target = self.call_target(call.expression(), &mut HashSet::new());
            let Some(params) = targets.get(&target) else {
                continue;
            };
            let arguments: Vec<_> = call.arguments().into_iter().collect();
            // A spread has no fixed source slots in this frontend contract.
            if arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
            {
                continue;
            }
            for (index, param) in params.iter().copied().enumerate() {
                if param.name().kind() != SyntaxKind::Identifier
                    || !param.dot_dot_dot_token().is_nil()
                {
                    continue;
                }
                let symbol = self.symbol(param.name());
                edges.push((symbol, arguments.get(index).copied()));
            }
        }
        // Monotone union of every call demand, including chains of parameters.
        // No generated function can freeze its slots from the first call site.
        loop {
            let mut changed = false;
            for (symbol, argument) in &edges {
                if !self.js_absence_parameters.contains(symbol)
                    && argument
                        .is_none_or(|arg| self.argument_may_be_absent(arg, &mut HashSet::new()))
                {
                    changed |= self.js_absence_parameters.insert(*symbol);
                }
            }
            if !changed {
                break;
            }
        }
    }

    fn call_target(&mut self, node: Node, seen: &mut HashSet<u32>) -> u32 {
        let node = receivers::reference_node(node);
        if node.kind() != SyntaxKind::Identifier {
            return 0;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !seen.insert(symbol) {
            return 0;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.initializer().is_nil()
        {
            let initial = receivers::reference_node(declaration.initializer());
            if initial.kind() == SyntaxKind::Identifier {
                // Only immutable aliases denote one target throughout execution.
                if declaration.parent().flags().intersects(NodeFlags::CONST) {
                    return self.call_target(initial, seen);
                }
                return 0;
            }
        }
        symbol
    }

    pub(super) fn argument_may_be_absent(&mut self, node: Node, seen: &mut HashSet<u32>) -> bool {
        if node.is_nil() {
            return true;
        }
        let node = receivers::reference_node(node);
        if self.planned_field_read(node) {
            return true;
        }
        let ty = self.checker.get_type_at_location(node);
        if self.source_has_undefined(ty) {
            return true;
        }
        match node.kind() {
            SyntaxKind::VoidExpression => true,
            SyntaxKind::Identifier => {
                let symbol = self.symbol(node);
                if self.js_absence_parameters.contains(&symbol) {
                    return true;
                }
                if symbol == 0 || !seen.insert(symbol) {
                    return false;
                }
                let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
                !declaration.is_nil()
                    && declaration.kind() == SyntaxKind::VariableDeclaration
                    && !declaration.initializer().is_nil()
                    && self.argument_may_be_absent(declaration.initializer(), seen)
            }
            SyntaxKind::ElementAccessExpression => {
                if self
                    .literal_property_key(node.argument_expression())
                    .as_deref()
                    == Some("length")
                {
                    return false;
                }
                let receiver = receivers::reference_node(node.expression());
                let name = if receiver.kind() == SyntaxKind::PropertyAccessExpression {
                    receiver.name()
                } else {
                    receiver
                };
                let symbol = self.symbol(name);
                let source = if symbol != 0 {
                    self.checker.get_type_of_symbol(SymbolId(symbol))
                } else {
                    self.checker.get_type_at_location(receiver)
                };
                let arms = if self.checker.ty(source).flags.intersects(TypeFlags::UNION) {
                    self.checker.ty(source).types().to_vec()
                } else {
                    vec![source]
                };
                let nullable = arms.iter().any(|id| {
                    self.checker
                        .ty(*id)
                        .flags
                        .intersects(TypeFlags::NULL | TypeFlags::UNDEFINED)
                });
                arms.into_iter().any(|id| {
                    (nullable && self.checker.is_array_type(id))
                        || (!self.checker.is_array_type(id)
                            && !self.checker.is_tuple_type(id)
                            && !self.checker.get_index_infos_of_type(id).is_empty())
                })
            }
            SyntaxKind::ConditionalExpression => {
                self.argument_may_be_absent(node.when_true(), &mut seen.clone())
                    || self.argument_may_be_absent(node.when_false(), seen)
            }
            _ => false,
        }
    }

    pub(super) fn source_has_undefined(&self, ty: TypeId) -> bool {
        let source = self.checker.ty(ty);
        source
            .flags
            .intersects(TypeFlags::UNDEFINED | TypeFlags::VOID)
            || (source.flags.intersects(TypeFlags::UNION)
                && source
                    .types()
                    .iter()
                    .any(|id| self.source_has_undefined(*id)))
    }
}
