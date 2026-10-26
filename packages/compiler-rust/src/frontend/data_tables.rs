//! Pure JavaScript tables use an owning data ABI when no typed layout exists.
//! Decide storage before var instantiation, including aliases across modules.
use super::*;
use source_frontend::flags::ContextFlags;

fn variables(node: Node, out: &mut Vec<Node>) {
    if node.kind() == SyntaxKind::VariableDeclaration {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        variables(child, out);
        false
    });
}

impl Lowerer<'_> {
    fn mixed_object_table(&self, node: Node) -> bool {
        match node.kind() {
            SyntaxKind::ObjectLiteralExpression => node.properties().into_iter().any(|p| {
                p.kind() == SyntaxKind::PropertyAssignment
                    && self.mixed_object_table(p.initializer())
            }),
            SyntaxKind::ArrayLiteralExpression => {
                // Endpoint tables mix a string head with distinct option
                // records. They have no single closed element layout; keep
                // the original data instead of choosing an ambiguous arm.
                let elements = node.elements().into_iter().collect::<Vec<_>>();
                (elements
                    .iter()
                    .any(|n| n.kind() == SyntaxKind::ObjectLiteralExpression)
                    && elements
                        .iter()
                        .any(|n| n.kind() != SyntaxKind::ObjectLiteralExpression))
                    || elements.into_iter().any(|n| self.mixed_object_table(n))
            }
            _ => false,
        }
    }

    fn pure_data_literal(&mut self, node: Node) -> bool {
        match node.kind() {
            SyntaxKind::StringLiteral
            | SyntaxKind::NoSubstitutionTemplateLiteral
            | SyntaxKind::NumericLiteral
            | SyntaxKind::TrueKeyword
            | SyntaxKind::FalseKeyword
            | SyntaxKind::NullKeyword => true,
            SyntaxKind::PrefixUnaryExpression => {
                node.operator() == SyntaxKind::MinusToken
                    && node.operand().kind() == SyntaxKind::NumericLiteral
            }
            SyntaxKind::ArrayLiteralExpression => node
                .elements()
                .into_iter()
                .all(|n| self.pure_data_literal(n)),
            SyntaxKind::ObjectLiteralExpression => {
                let mut names = HashSet::new();
                node.properties().into_iter().all(|p| {
                    if p.kind() != SyntaxKind::PropertyAssignment {
                        return false;
                    }
                    let Some(name) = self.data_property_name(p.name()) else {
                        return false;
                    };
                    name != "__proto__"
                        && names.insert(name)
                        && self.pure_data_literal(p.initializer())
                })
            }
            _ => false,
        }
    }

    pub(super) fn inventory_data_tables(&mut self, files: &[Node]) {
        let mut aliases = Vec::new();
        for file in files {
            let path = source_file_info(*file).file_name.to_string();
            if !path.ends_with(".js") && !path.ends_with(".mjs") && !path.ends_with(".cjs") {
                continue;
            }
            self.file = path;
            // A private inferred JS empty seed is an extensible ordinary
            // object. Select its owning store before cells/captures exist;
            // do not erase a contextual or published declaration contract.
            let mut declarations = Vec::new();
            variables(*file, &mut declarations);
            for declaration in declarations {
                if declaration.name().kind() != SyntaxKind::Identifier
                    || !declaration.type_().is_nil()
                    || declaration.initializer().is_nil()
                    || self.declared(declaration).is_some()
                {
                    continue;
                }
                let init = receivers::reference_node(declaration.initializer());
                if init.kind() == SyntaxKind::Identifier {
                    aliases.push((self.symbol(declaration.name()), self.symbol(init)));
                } else if init.kind() == SyntaxKind::ObjectLiteralExpression
                    && init.properties().is_empty()
                    && self.checker.get_contextual_type(init, ContextFlags::NONE).0 == 0
                {
                    let symbol = self.symbol(declaration.name());
                    self.data_bindings.insert(symbol);
                    // Carry this literal's inferred identity through private
                    // returns and captures. Never mark a contextual/public
                    // annotation's type as an owning object.
                    self.data_types
                        .insert(self.checker.get_type_at_location(declaration.name()));
                    self.data_types
                        .insert(self.checker.get_type_at_location(init));
                }
            }
            for statement in file.statements() {
                if statement.kind() != SyntaxKind::VariableStatement {
                    continue;
                }
                for declaration in statement.declaration_list().declarations().nodes() {
                    if declaration.name().kind() != SyntaxKind::Identifier
                        || self.declared(declaration).is_some()
                    {
                        continue;
                    }
                    let init = declaration.initializer();
                    if init.is_nil() {
                        continue;
                    }
                    let symbol = self.symbol(declaration.name());
                    if init.kind() == SyntaxKind::Identifier {
                        aliases.push((symbol, self.symbol(init)));
                    } else if matches!(
                        init.kind(),
                        SyntaxKind::ObjectLiteralExpression | SyntaxKind::ArrayLiteralExpression
                    ) && self.pure_data_literal(init)
                        && (self.ty(declaration.name()).is_err()
                            || (init.kind() == SyntaxKind::ObjectLiteralExpression
                                && self.checker.get_contextual_type(init, ContextFlags::NONE).0
                                    == 0
                                && self.mixed_object_table(init)))
                    {
                        self.data_bindings.insert(symbol);
                        self.data_types
                            .insert(self.checker.get_type_at_location(declaration.name()));
                    }
                }
            }
        }
        loop {
            let mut changed = false;
            for (alias, source) in &aliases {
                if self.data_bindings.contains(source) {
                    changed |= self.data_bindings.insert(*alias);
                }
            }
            if !changed {
                break;
            }
        }
    }
}
