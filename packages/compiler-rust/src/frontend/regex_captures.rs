//! Capture rows keep absent groups in their element ABI, independently of null results.
use super::*;

impl Lowerer<'_> {
    // This local proof is deliberately bounded: no operation can mutate the
    // capture array between the test and the first argument's evaluation.
    // Wider control flow needs an invalidation-aware property fact analysis.
    pub(super) fn guarded_capture_argument(
        &mut self,
        node: Node,
        value: Expr,
        target: &Type,
    ) -> Option<Expr> {
        if *target != Type::String
            || node.kind() != SyntaxKind::ElementAccessExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        let arms = &self.unions[union_id].arms;
        if arms.len() != 2 || !arms.contains(&Type::Undefined) {
            return None;
        }
        let tag = arms.iter().position(|arm| *arm == Type::String)?;
        let source_type = self.checker.get_type_at_location(node.expression());
        if !self.is_regex_capture_type(source_type) {
            return None;
        }
        let index = self.literal_property_key(node.argument_expression())?;
        if index
            .parse::<u32>()
            .ok()
            .is_none_or(|n| n.to_string() != index || n == u32::MAX)
        {
            return None;
        }
        let call = node.parent();
        if call.kind() != SyntaxKind::CallExpression
            || call.expression().kind() != SyntaxKind::Identifier
            || call.arguments().into_iter().next()? != node
        {
            return None;
        }
        let ret = call.parent();
        if ret.kind() != SyntaxKind::ReturnStatement || ret.expression() != call {
            return None;
        }
        let block = ret.parent();
        if block.kind() != SyntaxKind::Block {
            return None;
        }
        let statements = block.statements().into_iter().collect::<Vec<_>>();
        let previous = statements
            .iter()
            .position(|statement| *statement == ret)?
            .checked_sub(1)?;
        let guard = statements[previous];
        if guard.kind() != SyntaxKind::IfStatement || !guard.else_statement().is_nil() {
            return None;
        }
        let body = guard.then_statement();
        let throws = if body.kind() == SyntaxKind::ThrowStatement {
            true
        } else if body.kind() == SyntaxKind::Block {
            let statements = body.statements().into_iter().collect::<Vec<_>>();
            statements.len() == 1 && statements[0].kind() == SyntaxKind::ThrowStatement
        } else {
            false
        };
        if !throws {
            return None;
        }
        let condition = primitives::primitive_source(guard.expression());
        if condition.kind() != SyntaxKind::BinaryExpression
            || condition.operator_token().kind() != SyntaxKind::EqualsEqualsEqualsToken
        {
            return None;
        }
        let (slot, undefined) = if primitives::primitive_source(condition.left()).kind()
            == SyntaxKind::ElementAccessExpression
        {
            (
                primitives::primitive_source(condition.left()),
                primitives::primitive_source(condition.right()),
            )
        } else {
            (
                primitives::primitive_source(condition.right()),
                primitives::primitive_source(condition.left()),
            )
        };
        if slot.kind() != SyntaxKind::ElementAccessExpression
            || slot.question_dot_token().is_nil()
            || slot.expression().kind() != SyntaxKind::Identifier
            || self.symbol(slot.expression()) != self.symbol(node.expression())
            || self.literal_property_key(slot.argument_expression())? != index
            || undefined.kind() != SyntaxKind::Identifier
            || undefined.text() != "undefined"
        {
            return None;
        }
        let symbol = self.symbol(undefined);
        if symbol == 0
            || !self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .value_declaration
                .is_nil()
        {
            return None;
        }
        Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag,
            value: Box::new(value),
            r#type: Type::String,
            loc: self.loc(node),
        })
    }

    pub(super) fn is_regex_capture_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.name.as_ref() == "RegExpExecArray"
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                decl.kind() == SyntaxKind::InterfaceDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(*decl))
                            .file_name,
                    )
                    .is_some()
            })
    }
    pub(super) fn regex_capture_slot(&mut self) -> Type {
        self.intern_union(vec![Type::String, Type::Undefined])
            .expect("capture element")
    }
    pub(super) fn regex_capture_array(&mut self) -> Type {
        Type::Array {
            elem: Box::new(self.regex_capture_slot()),
        }
    }
    pub(super) fn regex_capture_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if !matches!(
            node.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) {
            return Ok(None);
        }
        let source_type = self.checker.get_type_at_location(node.expression());
        if !self.is_regex_capture_type(source_type) {
            return Ok(None);
        }
        let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
            Some(node.name().text().to_owned())
        } else {
            self.literal_property_key(node.argument_expression())
        };
        let Some(name) = name else {
            let key_type = self
                .checker
                .get_type_at_location(node.argument_expression());
            if !self
                .checker
                .ty(key_type)
                .flags
                .intersects(TypeFlags::NUMBER_LIKE)
            {
                return Err(self.refuse(
                    node,
                    "RegExp result computed keys require numeric indices or literal metadata names",
                ));
            }
            return Ok(None);
        };
        let result = match name.as_str() {
            "index" => Type::F64,
            "input" => Type::String,
            "groups" | "indices" => {
                return Err(self.refuse(
                    node,
                    "RegExp result group objects and indices are not ported",
                ));
            }
            _ => return Ok(None),
        };
        let receiver = self.expression(node.expression())?;
        let receiver = self.live_member_receiver(node.expression(), receiver);
        let receiver = self.coerce(receiver, Type::Dyn, node)?;
        let value = self.dynamic_get(
            node,
            receiver,
            Expr::StrLit {
                value: name,
                r#type: Type::String,
                loc: self.loc(node),
            },
        );
        self.coerce(value, result, node).map(Some)
    }
}
