//! Direct Node assert calls keep their native module provenance and truthiness.
use super::*;

impl Lowerer<'_> {
    pub(super) fn node_assert_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        let module = if callee.kind() == SyntaxKind::Identifier {
            self.native_namespace(callee)
        } else if callee.kind() == SyntaxKind::PropertyAccessExpression
            && callee.name().text() == "ok"
        {
            self.native_namespace(callee.expression())
        } else {
            None
        };
        if !matches!(module, Some("assert" | "assert/strict")) {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty()
            || arguments.len() > 2
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "node:assert ok requires a value and optional string message",
            ));
        }
        let condition = self.expression(arguments[0])?;
        let condition = self.coerce(condition, Type::Dyn, arguments[0])?;
        let message = if let Some(message) = arguments.get(1) {
            self.expected_expression(*message, Type::String)?
        } else {
            Expr::StrLit {
                value: "The expression evaluated to a falsy value".into(),
                r#type: Type::String,
                loc: self.loc(node),
            }
        };
        Ok(Some(Expr::LibCall {
            r#fn: "assert.ok".into(),
            args: vec![condition, message],
            r#type: Type::Void,
            loc: self.loc(node),
        }))
    }
}
