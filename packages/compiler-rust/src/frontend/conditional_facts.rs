//! Bounded proofs for a conditional result derived from an immutable value.
use super::*;
use source_frontend::prelude::SymbolId;

impl Lowerer<'_> {
    fn const_initializer(&self, symbol: u32) -> Option<Node> {
        if symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || declaration.name().kind() != SyntaxKind::Identifier
            || !declaration.parent().flags().intersects(NodeFlags::CONST)
            || declaration.initializer().is_nil()
        {
            return None;
        }
        Some(primitives::primitive_source(declaration.initializer()))
    }

    fn literal_zero(&self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        node.kind() == SyntaxKind::NumericLiteral
            && source_frontend::jsnum::from_string(&node.text().replace('_', "")).value() == 0.0
    }

    fn pure_prior_argument(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() == SyntaxKind::Identifier {
            return self.binding(node).is_ok();
        }
        if matches!(
            node.kind(),
            SyntaxKind::NumericLiteral | SyntaxKind::StringLiteral
        ) {
            return true;
        }
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.name().text() != "length"
            || !node.question_dot_token().is_nil()
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return false;
        }
        self.binding(node.expression())
            .is_ok_and(|local| matches!(local.r#type, Type::Array { .. }))
    }

    /// If `const d = x == null ? 0 : ...` and `d !== 0`, immutable x is
    /// non-nullish. Only use the proof in an immediately selected call arm:
    /// no preceding argument may invoke user code or mutate observable state.
    pub(super) fn guarded_derived_argument(
        &mut self,
        node: Node,
        value: Expr,
        target: &Type,
    ) -> Option<Expr> {
        if node.kind() != SyntaxKind::NonNullExpression || *target != Type::F64 {
            return None;
        }
        let source = primitives::primitive_source(node.expression());
        if source.kind() != SyntaxKind::Identifier {
            return None;
        }
        let source_symbol = self.symbol(source);
        self.const_initializer(source_symbol)?;
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        let arms = &self.unions[union_id].arms;
        if !arms
            .iter()
            .all(|arm| matches!(arm, Type::F64 | Type::Null | Type::Undefined))
        {
            return None;
        }
        let tag = arms.iter().position(|arm| *arm == Type::F64)?;
        let call = node.parent();
        if call.kind() != SyntaxKind::CallExpression
            || call.expression().kind() != SyntaxKind::Identifier
            || !call.question_dot_token().is_nil()
        {
            return None;
        }
        let args = call.arguments().into_iter().collect::<Vec<_>>();
        let index = args.iter().position(|arg| *arg == node)?;
        if !args[..index]
            .iter()
            .all(|arg| self.pure_prior_argument(*arg))
        {
            return None;
        }
        let conditional = call.parent();
        if conditional.kind() != SyntaxKind::ConditionalExpression {
            return None;
        }
        let guard = primitives::primitive_source(conditional.condition());
        if guard.kind() != SyntaxKind::BinaryExpression {
            return None;
        }
        let branch_unequal = match guard.operator_token().kind() {
            SyntaxKind::EqualsEqualsEqualsToken => conditional.when_false() == call,
            SyntaxKind::ExclamationEqualsEqualsToken => conditional.when_true() == call,
            _ => false,
        };
        if !branch_unequal {
            return None;
        }
        let derived = if self.literal_zero(guard.right()) {
            primitives::primitive_source(guard.left())
        } else if self.literal_zero(guard.left()) {
            primitives::primitive_source(guard.right())
        } else {
            return None;
        };
        if derived.kind() != SyntaxKind::Identifier {
            return None;
        }
        let derived_symbol = self.symbol(derived);
        let initializer = self.const_initializer(derived_symbol)?;
        if initializer.kind() != SyntaxKind::ConditionalExpression
            || !self.literal_zero(initializer.when_true())
        {
            return None;
        }
        let condition = primitives::primitive_source(initializer.condition());
        if condition.kind() != SyntaxKind::BinaryExpression
            || condition.operator_token().kind() != SyntaxKind::EqualsEqualsToken
        {
            return None;
        }
        let (candidate, unit) = (
            primitives::primitive_source(condition.left()),
            primitives::primitive_source(condition.right()),
        );
        let mut proven = |value: Node, null: Node| {
            value.kind() == SyntaxKind::Identifier
                && self.symbol(value) == source_symbol
                && null.kind() == SyntaxKind::NullKeyword
        };
        if !proven(candidate, unit) && !proven(unit, candidate) {
            return None;
        }
        Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag,
            value: Box::new(value),
            r#type: target.clone(),
            loc: self.loc(node),
        })
    }
}
