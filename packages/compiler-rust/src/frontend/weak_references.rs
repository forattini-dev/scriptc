//! Engine-free WeakRef and FinalizationRegistry surface used for lifecycle hints.
use super::*;

impl Lowerer<'_> {
    pub(super) fn native_weak_reference_constructor(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() != SyntaxKind::NewExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return false;
        }
        let symbol = self.symbol(node.expression());
        self.standard_name(symbol, &["WeakRef", "FinalizationRegistry"])
            .is_some()
    }

    pub(super) fn weak_reference_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::NewExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let symbol = self.symbol(node.expression());
        let Some(name) = self.standard_name(symbol, &["WeakRef", "FinalizationRegistry"]) else {
            return Ok(None);
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !matches!(arguments.as_slice(), [argument] if argument.kind() != SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                &format!("{name} requires exactly one represented argument"),
            ));
        }
        let argument = self.expected_expression(arguments[0], Type::Dyn)?;
        Ok(Some(Expr::Intrinsic {
            name: if name == "WeakRef" {
                "weakRef.new"
            } else {
                "finalizationRegistry.new"
            }
            .into(),
            args: vec![argument],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
}
