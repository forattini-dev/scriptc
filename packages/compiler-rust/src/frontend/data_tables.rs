//! Pure JavaScript tables use an owning data ABI when no typed layout exists.
//! Decide storage before var instantiation, including aliases across modules.
use super::*;

impl Lowerer<'_> {
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
                        && self.ty(declaration.name()).is_err()
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
