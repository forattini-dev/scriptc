//! Indexed references retain the owner, key, and unrounded assignment result.
use super::*;

impl Lowerer<'_> {
    fn typed_array_numeric_index(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if value.ty() == Type::F64 {
            return Ok(value);
        }
        if value.ty() == Type::Bigint {
            return Ok(self.bigint_operation("bigint.toNumber", vec![value], node));
        }
        if value.ty() == Type::Dyn {
            let source = primitives::primitive_source(node);
            if source.kind() != SyntaxKind::BinaryExpression
                || updates::compound_operator(source.operator_token().kind()).is_none()
                    && !matches!(
                        source.operator_token().kind(),
                        SyntaxKind::PlusToken
                            | SyntaxKind::MinusToken
                            | SyntaxKind::AsteriskToken
                            | SyntaxKind::SlashToken
                            | SyntaxKind::PercentToken
                            | SyntaxKind::AsteriskAsteriskToken
                            | SyntaxKind::AmpersandToken
                            | SyntaxKind::BarToken
                            | SyntaxKind::CaretToken
                            | SyntaxKind::LessThanLessThanToken
                            | SyntaxKind::GreaterThanGreaterThanToken
                            | SyntaxKind::GreaterThanGreaterThanGreaterThanToken
                    )
            {
                return Err(
                    self.refuse(node, "typed array writes require a represented numeric key")
                );
            }
            return Ok(Expr::LibCall {
                r#fn: "dyn.typedArrayNumericIndex".into(),
                args: vec![value],
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        let Type::Union { union_id } = value.ty() else {
            return Err(self.refuse(node, "typed array writes require a represented numeric key"));
        };
        let arms = self.unions[union_id].arms.clone();
        if arms.len() != 2 || !arms.contains(&Type::F64) || !arms.contains(&Type::Bigint) {
            return Err(self.refuse(node, "typed array writes require a represented numeric key"));
        }
        let number_tag = arms.iter().position(|arm| *arm == Type::F64).unwrap();
        let bigint_tag = arms.iter().position(|arm| *arm == Type::Bigint).unwrap();
        let input_type = Type::Union { union_id };
        let mut helper = helpers::Helper::new(
            "typed_array_numeric_index",
            vec![input_type.clone()],
            Type::F64,
            self.loc(node),
        );
        let input = helper.read(&helper.param(0));
        let bigint = Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag: bigint_tag,
            value: Box::new(input.clone()),
            r#type: Type::Bigint,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::If {
            cond: Expr::UnionIsTag {
                union_id: format!("u{union_id}"),
                tag: bigint_tag,
                value: Box::new(input.clone()),
                negated: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(self.bigint_operation("bigint.toNumber", vec![bigint], node)),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag: number_tag,
                value: Box::new(input),
                r#type: Type::F64,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![value],
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    pub(super) fn bytes_assignment(
        &mut self,
        node: Node,
        op: Option<&str>,
    ) -> Result<Option<Expr>, String> {
        let member = primitives::primitive_source(node.left());
        if member.kind() != SyntaxKind::ElementAccessExpression {
            return Ok(None);
        }
        let source = receivers::reference_node(member.expression());
        let represented = if source.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(source);
            self.bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|local| local.r#type.clone())
                .or_else(|| self.var_types.get(&symbol).cloned())
        } else {
            None
        }
        .or_else(|| self.ty(member.expression()).ok());
        if !matches!(represented, Some(Type::Bytes { .. })) {
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
        let index = self.typed_array_numeric_index(index, member.argument_expression())?;
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
