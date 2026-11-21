//! Object methods are owning function-valued data fields with call-site this.
use super::*;

impl Lowerer<'_> {
    pub(super) fn object_property_value(
        &mut self,
        property: Node,
        target: Type,
    ) -> Result<Expr, String> {
        if property.kind() != SyntaxKind::MethodDeclaration {
            let value = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                property.name()
            } else {
                property.initializer()
            };
            return self.expected_expression(value, target);
        }
        if property.parent().kind() != SyntaxKind::ObjectLiteralExpression
            || !property.asterisk_token().is_nil()
        {
            return Err(self.refuse(property, "generator object methods are not ported"));
        }
        fn uses_super(node: Node, root: bool) -> bool {
            if node.kind() == SyntaxKind::SuperKeyword {
                return true;
            }
            if !root
                && matches!(
                    node.kind(),
                    SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                )
            {
                return false;
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found |= uses_super(child, false);
                false
            });
            found
        }
        if uses_super(property, true) {
            return Err(self.refuse(
                property,
                "object method super requires a native home-object contract",
            ));
        }
        self.expected_expression(property, target)
    }
}
