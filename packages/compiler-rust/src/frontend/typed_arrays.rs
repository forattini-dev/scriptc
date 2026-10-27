//! Indexed references retain the owner, key, and unrounded assignment result.
use super::*;

impl Lowerer<'_> {
    pub(super) fn bytes_assignment(
        &mut self,
        node: Node,
        op: Option<&str>,
    ) -> Result<Option<Expr>, String> {
        let member = primitives::primitive_source(node.left());
        if member.kind() != SyntaxKind::ElementAccessExpression
            || !matches!(self.ty(member.expression()), Ok(Type::Bytes { .. }))
        {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        self.bytes_assignment_value(node, receiver, op).map(Some)
    }

    pub(super) fn bytes_assignment_value(
        &mut self,
        node: Node,
        receiver: Expr,
        op: Option<&str>,
    ) -> Result<Expr, String> {
        let member = primitives::primitive_source(node.left());
        let loc = self.loc(node);
        let mut stmts = Vec::new();
        let receiver = self.update_temp(receiver, &mut stmts, member);
        let index = self.expression(member.argument_expression())?;
        if index.ty() != Type::F64 {
            return Err(self.refuse(
                member,
                "typed array writes require a represented numeric key",
            ));
        }
        let index = self.update_temp(index, &mut stmts, member);
        // GetValue precedes the RHS for compound assignment, including an
        // undefined result for invalid indices. No borrow survives a callback.
        let old = if op.is_some() {
            let old = self.bytes_index_value(member, receiver.clone(), index.clone())?;
            Some(self.update_temp(old, &mut stmts, member))
        } else {
            None
        };
        let right = self.primitive_operand(node.right())?;
        if !self.numeric_operand_domain(&right.ty()) {
            return Err(self.refuse(
                node,
                "typed array assignment object coercion hooks are not ported",
            ));
        }
        let right = self.primitive_capture(right, node.right())?;
        let right = self.update_temp(right, &mut stmts, node);
        let value = if let Some(op) = op {
            self.numeric_binary(old.unwrap(), right, op, node)?
        } else {
            right
        };
        let result_type = value.ty();
        let value = self.update_temp(value, &mut stmts, node);
        // Conversion happens even when an integer-indexed write is ignored.
        // Preserve the original result: f32 rounding belongs only to storage.
        self.ensure_exception_classes(node)?;
        let number = self.strict_number_primitive(value.clone(), node)?;
        let number = self.update_temp(number, &mut stmts, node);
        let bin = |op: &str, left, right| Expr::Bin {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type: if op == "%" { Type::F64 } else { Type::Bool },
            loc: loc.clone(),
        };
        let num = |value| Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let length = self.bytes_operation(node, receiver.clone(), "length", vec![], Type::F64);
        let and = |left, right| Expr::Logical {
            op: "&&".into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let valid = and(
            and(
                bin(">=", index.clone(), num(0.0)),
                bin("<", index.clone(), length),
            ),
            bin("===", bin("%", index.clone(), num(1.0)), num(0.0)),
        );
        stmts.push(Stmt::If {
            cond: valid,
            then: vec![Stmt::BytesSet {
                arr: receiver,
                index,
                value: number,
                loc: loc.clone(),
            }],
            else_: None,
            loc: loc.clone(),
        });
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(value),
            r#type: result_type,
            loc,
        })
    }
}
