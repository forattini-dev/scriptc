//! Read/modify/write references retain their receiver and old owning value.
use super::*;

enum Target {
    Local {
        local: Local,
        symbol: u32,
    },
    Record {
        obj: Expr,
        shape_id: usize,
        field: ir::Field,
    },
}

pub(super) fn compound_operator(kind: SyntaxKind) -> Option<&'static str> {
    Some(match kind {
        SyntaxKind::PlusEqualsToken => "+",
        SyntaxKind::MinusEqualsToken => "-",
        SyntaxKind::AsteriskEqualsToken => "*",
        SyntaxKind::SlashEqualsToken => "/",
        SyntaxKind::PercentEqualsToken => "%",
        SyntaxKind::AsteriskAsteriskEqualsToken => "**",
        SyntaxKind::AmpersandEqualsToken => "&",
        SyntaxKind::BarEqualsToken => "|",
        SyntaxKind::CaretEqualsToken => "^",
        SyntaxKind::LessThanLessThanEqualsToken => "<<",
        SyntaxKind::GreaterThanGreaterThanEqualsToken => ">>",
        SyntaxKind::GreaterThanGreaterThanGreaterThanEqualsToken => ">>>",
        _ => return None,
    })
}

impl Lowerer<'_> {
    pub(super) fn compound_assignment(&mut self, node: Node, op: &str) -> Result<Expr, String> {
        let operand = primitives::primitive_source(node.left());
        if operand.kind() != SyntaxKind::Identifier {
            return Err(self.refuse(node, "compound assignment requires a mutable native binding; property references are not ported"));
        }
        let symbol = self.symbol(operand);
        if self.enum_type(operand).is_some() || self.native_namespaces.contains_key(&symbol) {
            return Err(self.refuse(node, "compound namespace assignments are not ported"));
        }
        let local = self.binding(operand)?;
        let storage = local.r#type.clone();
        let numeric = |ty: &Type| {
            matches!(ty, Type::F64 | Type::Bigint | Type::Dyn)
                || matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.iter().any(|arm| matches!(arm, Type::F64 | Type::Bigint)) && self.unions[*union_id].arms.iter().all(|arm| matches!(arm, Type::F64 | Type::Bigint | Type::Undefined)))
        };
        if !local.mutable || !(numeric(&storage) || op == "+" && storage == Type::String) {
            return Err(self.refuse(node, "compound assignment requires mutable numeric, erased primitive, or string += storage"));
        }
        let loc = self.loc(node);
        let mut stmts = Vec::new();
        // GetValue of the left reference precedes every RHS effect. Keep the
        // actual owning tag, including undefined after a captured-slot write.
        let old = self.update_temp(
            Expr::VarRef {
                local_id: local.id.clone(),
                r#type: storage.clone(),
                loc: loc.clone(),
            },
            &mut stmts,
            node,
        );
        let right = self.primitive_operand(node.right())?;
        let right_numeric = self.numeric_operand_domain(&right.ty()) || right.ty() == Type::Void;
        if (storage == Type::String && right.ty() != Type::String)
            || (storage != Type::String && !right_numeric)
        {
            return Err(self.refuse(node, "compound operand domain is not ported; numeric bindings require primitives and string += requires string"));
        }
        let right = self.primitive_capture(right, node.right())?;
        let right = self.update_temp(right, &mut stmts, node);
        // Conversions belong after RHS GetValue. Typed numeric += cannot
        // publish a string into its already allocated storage contract.
        if op == "+"
            && storage != Type::Dyn
            && storage != Type::String
            && self.numeric_domain(&right.ty(), true) & 4 != 0
        {
            return Err(self.refuse(
                node,
                "compound += operand may change numeric storage to string",
            ));
        }
        let value = if storage == Type::String {
            self.string_concat(old, right, node)
        } else if old.ty() == Type::F64 && right.ty() == Type::F64 {
            Expr::Bin {
                op: op.into(),
                left: Box::new(old),
                right: Box::new(right),
                r#type: Type::F64,
                loc: loc.clone(),
            }
        } else {
            self.numeric_binary(old, right, op, node)?
        };
        let result_type = value.ty();
        let value = self.update_temp(value, &mut stmts, node);
        if storage == Type::Bigint && op == ">>>" {
            // ToNumeric retains this left BigInt. Every RHS domain throws,
            // so there is no successful Number payload to store in the cell.
            return Ok(Expr::Sequence {
                stmts,
                result: Box::new(value),
                r#type: result_type,
                loc,
            });
        }
        let stored = self.coerce(value.clone(), storage, node)?;
        if self.var_types.contains_key(&symbol) {
            self.var_assignment_fact(symbol, &stored);
        }
        stmts.push(Stmt::Assign {
            local_id: local.id,
            initializes_global: false,
            value: stored,
            loc: loc.clone(),
        });
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(value),
            r#type: result_type,
            loc,
        })
    }

    pub(super) fn update_expression(&mut self, node: Node) -> Result<Expr, String> {
        let operand = primitives::primitive_source(node.operand());
        let loc = self.loc(node);
        let mut stmts = Vec::new();
        let (target, value, storage) = match operand.kind() {
            SyntaxKind::Identifier => {
                let symbol = self.symbol(operand);
                if self.enum_type(operand).is_some() || self.native_namespaces.contains_key(&symbol)
                {
                    return Err(self.refuse(node, "namespace updates are not ported"));
                }
                let local = self.binding(operand)?;
                if !local.mutable || local.r#type == Type::Caught {
                    return Err(
                        self.refuse(node, "update requires a mutable native numeric binding")
                    );
                }
                // Read the actual cell, including undefined after a callback
                // or backedge, rather than the checker's flow projection.
                let value = Expr::VarRef {
                    local_id: local.id.clone(),
                    r#type: local.r#type.clone(),
                    loc: loc.clone(),
                };
                let storage = local.r#type.clone();
                (Target::Local { local, symbol }, value, storage)
            }
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression => {
                if operand.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
                    || (operand.kind() == SyntaxKind::PropertyAccessExpression
                        && operand.name().kind() == SyntaxKind::PrivateIdentifier)
                {
                    return Err(self.refuse(
                        node,
                        "optional and private update references are not ported",
                    ));
                }
                let obj = self.expression(operand.expression())?;
                let Type::Record { shape_id } = obj.ty() else {
                    return Err(self.refuse(node, "update reference requires a closed native record; class accessors and indexed containers are not ported"));
                };
                let name = if operand.kind() == SyntaxKind::PropertyAccessExpression {
                    operand.name().text().to_string()
                } else {
                    self.literal_property_key(operand.argument_expression())
                        .ok_or_else(|| {
                            self.refuse(
                                node,
                                "closed record updates require a literal property key",
                            )
                        })?
                };
                if self.enum_shape(shape_id)
                    || self.callables.contains_key(&shape_id)
                    || self.records[shape_id].index_value.is_some()
                    || name == "__proto__"
                {
                    return Err(
                        self.refuse(node, "update requires an ordinary closed record data field")
                    );
                }
                let field = self.records[shape_id]
                    .fields
                    .iter()
                    .find(|f| f.name == name)
                    .cloned()
                    .ok_or_else(|| self.refuse(node, "unknown native update field"))?;
                // GetValue and PutValue use the same owning receiver even if
                // evaluating it mutates another source binding.
                let obj = self.update_temp(obj, &mut stmts, node);
                let value = Expr::RecordGet {
                    obj: Box::new(obj.clone()),
                    shape_id: format!("r{shape_id}"),
                    field: name,
                    r#type: field.r#type.clone(),
                    loc: loc.clone(),
                };
                let storage = field.r#type.clone();
                (
                    Target::Record {
                        obj,
                        shape_id,
                        field,
                    },
                    value,
                    storage,
                )
            }
            _ => return Err(self.refuse(node, "update operand has no native writable reference")),
        };
        // Numeric cells can retain an undefined tag after hoisting or a call.
        // Other source domains also require flow invalidation for subsequent
        // reads, so do not admit them just because conversion can produce f64.
        let numeric = storage == Type::F64
            || matches!(&storage, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::F64) && self.unions[*union_id].arms.iter().all(|arm| matches!(arm, Type::F64 | Type::Undefined)));
        if !numeric {
            return Err(self.refuse(node, "updates require number or undefined-capable numeric storage; other ToNumeric domains are not ported"));
        }
        let old = self.primitive_number(value, node)?;
        let old = self.update_temp(old, &mut stmts, node);
        let new = Expr::Bin {
            op: if node.operator() == SyntaxKind::PlusPlusToken {
                "+"
            } else {
                "-"
            }
            .into(),
            left: Box::new(old.clone()),
            right: Box::new(Expr::NumLit {
                value: 1.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let new = self.update_temp(new, &mut stmts, node);
        let stored = self.coerce(new.clone(), storage, node)?;
        let write = match target {
            Target::Local { local, symbol } => {
                if self.var_types.contains_key(&symbol) {
                    self.var_assignment_fact(symbol, &stored);
                }
                Stmt::Assign {
                    local_id: local.id,
                    initializes_global: false,
                    value: stored,
                    loc: loc.clone(),
                }
            }
            Target::Record {
                obj,
                shape_id,
                field,
            } => Stmt::RecordSet {
                obj,
                shape_id: format!("r{shape_id}"),
                field: field.name,
                value: stored,
                loc: loc.clone(),
            },
        };
        stmts.push(write);
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(if node.kind() == SyntaxKind::PostfixUnaryExpression {
                old
            } else {
                new
            }),
            r#type: Type::F64,
            loc,
        })
    }

    fn update_temp(&mut self, init: Expr, stmts: &mut Vec<Stmt>, node: Node) -> Expr {
        let local = Local {
            id: format!("update{}", self.locals.len()),
            name: "update reference value".into(),
            r#type: init.ty(),
            mutable: false,
            boxed: false,
        };
        stmts.push(Stmt::VarDecl {
            local_id: local.id.clone(),
            init,
            loc: self.loc(node),
        });
        let read = Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        };
        self.locals.push(local);
        read
    }
}
