//! Select an owning contextual layout before a fresh record is published.
use super::*;
use source_frontend::flags::ContextFlags;

fn identifiers(node: Node, out: &mut Vec<Node>) {
    if node.kind() == SyntaxKind::Identifier {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        identifiers(child, out);
        false
    });
}

impl Lowerer<'_> {
    // No expression may retain an alias to a nested object or execute code
    // before the record receives its one owning layout.
    fn fresh_literal(&self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        match node.kind() {
            SyntaxKind::StringLiteral
            | SyntaxKind::NoSubstitutionTemplateLiteral
            | SyntaxKind::NumericLiteral
            | SyntaxKind::TrueKeyword
            | SyntaxKind::FalseKeyword
            | SyntaxKind::NullKeyword => true,
            SyntaxKind::PrefixUnaryExpression => {
                matches!(
                    node.operator(),
                    SyntaxKind::PlusToken | SyntaxKind::MinusToken
                ) && node.operand().kind() == SyntaxKind::NumericLiteral
            }
            SyntaxKind::ArrayLiteralExpression => node
                .elements()
                .into_iter()
                .all(|item| self.fresh_literal(item)),
            SyntaxKind::ObjectLiteralExpression => node.properties().into_iter().all(|property| {
                property.kind() == SyntaxKind::PropertyAssignment
                    && self
                        .data_property_name(property.name())
                        .is_some_and(|name| name != "__proto__")
                    && self.fresh_literal(property.initializer())
            }),
            _ => false,
        }
    }

    pub(super) fn plan_contextual_record_storage(&mut self, files: &[Node]) {
        for file in files {
            let mut candidates = HashMap::new();
            for statement in file.statements() {
                if statement.kind() != SyntaxKind::VariableStatement
                    || statement.modifier_flags().intersects(ModifierFlags::EXPORT)
                {
                    continue;
                }
                let list = statement.declaration_list();
                if !list.flags().intersects(NodeFlags::CONST) {
                    continue;
                }
                for declaration in list.declarations().nodes() {
                    if declaration.name().kind() != SyntaxKind::Identifier
                        || !declaration.type_().is_nil()
                        || declaration.initializer().is_nil()
                        || declaration.initializer().kind() != SyntaxKind::ObjectLiteralExpression
                        || !self.fresh_literal(declaration.initializer())
                    {
                        continue;
                    }
                    let symbol = self.symbol(declaration.name());
                    if symbol != 0 {
                        candidates.insert(symbol, (declaration, Vec::new()));
                    }
                }
            }
            if candidates.is_empty() {
                continue;
            }
            let names = candidates
                .values()
                .map(|(decl, _)| decl.name().text().to_string())
                .collect::<HashSet<_>>();
            let mut all = Vec::new();
            identifiers(*file, &mut all);
            for name in all {
                if !names.contains(name.text()) {
                    continue;
                }
                let symbol = self.symbol(name);
                if let Some((decl, uses)) = candidates.get_mut(&symbol)
                    && name != decl.name()
                {
                    uses.push(name);
                }
            }
            for (symbol, (declaration, uses)) in candidates {
                let [usage] = uses.as_slice() else { continue };
                let array = usage.parent();
                if array.kind() != SyntaxKind::ArrayLiteralExpression
                    || array.parent().kind() != SyntaxKind::CallExpression
                    || !array
                        .parent()
                        .arguments()
                        .into_iter()
                        .any(|arg| arg == array)
                {
                    continue;
                }
                let context = self.checker.get_contextual_type(*usage, ContextFlags::NONE);
                let source = self.checker.get_type_at_location(*usage);
                if context.0 == 0 || !self.checker.is_type_assignable_to(source, context) {
                    continue;
                }
                let Some(target @ Type::Record { shape_id }) = self.type_id(context) else {
                    continue;
                };
                let shape = &self.records[shape_id];
                if shape.tuple
                    || shape.index_value.is_some()
                    || self.callables.contains_key(&shape_id)
                    || self.enum_shape(shape_id)
                    || self.is_data_view(&target)
                    || !declaration
                        .initializer()
                        .properties()
                        .into_iter()
                        .all(|property| {
                            self.data_property_name(property.name())
                                .is_some_and(|name| {
                                    shape.fields.iter().any(|field| field.name == name)
                                })
                        })
                {
                    continue;
                }
                self.contextual_record_storage.insert(symbol, target);
            }
        }
    }
}
