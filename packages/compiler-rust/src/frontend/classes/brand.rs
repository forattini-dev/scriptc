//! A narrow native representation of the registry-symbol Error brands used by
//! Undici. The static membership method and instance getter must match exactly.
use super::*;

impl Lowerer<'_> {
    pub(super) fn class_registry_brand(&mut self, class: Node) -> Option<(String, Node, Node)> {
        let method = class.members().into_iter().find(|member| {
            member.kind() == SyntaxKind::MethodDeclaration
                && member.modifier_flags().intersects(ModifierFlags::STATIC)
                && member.name().kind() == SyntaxKind::ComputedPropertyName
                && {
                    let key = member.name().expression();
                    key.kind() == SyntaxKind::PropertyAccessExpression
                        && key.name().text() == "hasInstance"
                        && self.standard_symbol(key.expression())
                }
        })?;
        let parameters = method.parameters().into_iter().collect::<Vec<_>>();
        let [parameter] = parameters.as_slice() else {
            return None;
        };
        if parameter.name().kind() != SyntaxKind::Identifier
            || method.body().is_nil()
            || method.body().statements().len() != 1
            || !method.type_parameters().is_empty()
        {
            return None;
        }
        let returned = method.body().statements().into_iter().next()?;
        if returned.kind() != SyntaxKind::ReturnStatement {
            return None;
        }
        let guard = returned.expression();
        if guard.kind() != SyntaxKind::BinaryExpression
            || guard.operator_token().kind() != SyntaxKind::AmpersandAmpersandToken
            || self.symbol(guard.left()) != self.symbol(parameter.name())
        {
            return None;
        }
        let comparison = guard.right();
        if comparison.kind() != SyntaxKind::BinaryExpression
            || comparison.operator_token().kind() != SyntaxKind::EqualsEqualsEqualsToken
            || comparison.right().kind() != SyntaxKind::TrueKeyword
        {
            return None;
        }
        let access = comparison.left();
        if access.kind() != SyntaxKind::ElementAccessExpression
            || self.symbol(access.expression()) != self.symbol(parameter.name())
        {
            return None;
        }
        let key_node = access.argument_expression();
        if key_node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(key_node);
        if symbol == 0 {
            return None;
        }
        let getter = class.members().into_iter().find(|member| {
            member.kind() == SyntaxKind::GetAccessor
                && !member.modifier_flags().intersects(ModifierFlags::STATIC)
                && member.name().kind() == SyntaxKind::ComputedPropertyName
                && self.symbol(member.name().expression()) == symbol
                && member.parameters().is_empty()
                && !member.body().is_nil()
                && member.body().statements().len() == 1
                && member
                    .body()
                    .statements()
                    .into_iter()
                    .next()
                    .is_some_and(|returned| {
                        returned.kind() == SyntaxKind::ReturnStatement
                            && returned.expression().kind() == SyntaxKind::TrueKeyword
                    })
        })?;
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        if declaration.kind() != SyntaxKind::VariableDeclaration
            || !declaration.parent().flags().intersects(NodeFlags::CONST)
            || declaration.end() > class.pos()
            || get_source_file_of_node(declaration) != get_source_file_of_node(class)
        {
            return None;
        }
        let initializer = declaration.initializer();
        if initializer.kind() != SyntaxKind::CallExpression || initializer.arguments().len() != 1 {
            return None;
        }
        let target = initializer.expression();
        if target.kind() != SyntaxKind::PropertyAccessExpression
            || target.name().text() != "for"
            || !self.standard_symbol(target.expression())
        {
            return None;
        }
        let argument = initializer.arguments().into_iter().next()?;
        if argument.kind() != SyntaxKind::StringLiteral {
            return None;
        }
        let bytes = source_frontend::scanner_util::go_string_bytes(argument.text());
        let registry_key = String::from_utf8(bytes.to_vec()).ok()?;
        Some((registry_key, method, getter))
    }
}
