//! Optional member chains keep their receiver cells and lazy keys in the IR.
use super::*;

pub(super) fn is_access(node: Node) -> bool {
    node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        && matches!(
            node.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        )
}

impl Lowerer<'_> {
    pub(super) fn live_member_receiver(&mut self, node: Node, value: Expr) -> Expr {
        let source_node = receivers::reference_node(node);
        let tracked_symbol = if source_node.kind() == SyntaxKind::Identifier {
            self.symbol(source_node)
        } else {
            0
        };
        if self.var_defined.contains(&tracked_symbol) {
            // Retain a live presence proof for a tracked local. Calls and
            // writes invalidate these facts before the next receiver read.
            return value;
        }
        if let Expr::UnionNarrow { value: source, .. } = &value
            && (self.array_view(&source.ty()) || self.string_view(&source.ty()))
        {
            // A checker refinement can outlive an alias/callback mutation.
            // Keep the actual nullable receiver for the property read.
            return source.as_ref().clone();
        }
        value
    }

    pub(super) fn optional_result_type(&mut self, value: Type, node: Node) -> Result<Type, String> {
        if matches!(value, Type::Null | Type::Undefined) {
            // Unit tags never occupy standalone ABI slots.
            return self.undefined_storage_type(Type::F64, node);
        }
        self.undefined_storage_type(value, node)
    }

    pub(super) fn optional_access(&mut self, node: Node) -> Result<Expr, String> {
        let mut steps = Vec::new();
        let mut base = node;
        while is_access(base) {
            steps.push(base);
            base = base.expression();
        }
        // Parentheses end a chain. A call inside a continuous chain needs its
        // own receiver ABI and must not be reinterpreted as a property read.
        if base.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
            && base.kind() == SyntaxKind::CallExpression
        {
            return Err(self.refuse(
                base,
                "optional calls require a native receiver-call contract",
            ));
        }
        steps.reverse();
        // Presence observes the live cell. Checker refinements can survive a
        // call which changes a captured/module binding to undefined.
        let value = self.condition_value(primitives::primitive_source(base))?;
        let value = match value {
            Expr::UnionNarrow { ref value, .. } if matches!(value.ty(), Type::Union { union_id } if self.unions[union_id].arms.iter().any(|arm| matches!(arm, Type::Null | Type::Undefined))) =>
            {
                // A data-field read may carry the same stale checker
                // refinement as an identifier. Test its original owning slot.
                value.as_ref().clone()
            }
            value => value,
        };
        self.optional_steps(value, &steps)
    }

    fn optional_steps(&mut self, value: Expr, steps: &[Node]) -> Result<Expr, String> {
        let Some((&node, rest)) = steps.split_first() else {
            return Ok(value);
        };
        let optional = !node.question_dot_token().is_nil();
        let known_nullish = matches!(value.ty(), Type::Null | Type::Undefined);
        if optional && known_nullish {
            let result_type = self.optional_result_type(Type::Undefined, node)?;
            let result = self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                result_type.clone(),
                node,
            )?;
            // Preserve a receiver's effects even when its result is statically
            // nullish. The complete remaining chain is skipped in this branch.
            return Ok(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: self.coerce(value, Type::Dyn, node)?,
                    loc: self.loc(node),
                }],
                result: Box::new(result),
                r#type: result_type,
                loc: self.loc(node),
            });
        }
        let local = Local {
            id: format!("optional{}", self.locals.len()),
            name: "optional receiver".into(),
            r#type: value.ty(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(local.clone());
        let read = || Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        };
        let (present, nullish) = self.optional_receiver(read(), node)?;
        let read_value = read();
        let before = self.var_defined.clone();
        let operation = if !optional && nullish.is_some() {
            // A non-optional continuation still evaluates its key and throws on
            // an absent value. Only a preceding ?. can skip the whole tail.
            let result_type = self.optional_member_type(node, &present.ty())?;
            let key = self.optional_key(node)?;
            let receiver = self.coerce(read_value, Type::Dyn, node)?;
            let value = self.dynamic_get(node, receiver, key);
            self.coerce(value, result_type, node)?
        } else {
            self.optional_member(node, present)?
        };
        let tail = self.optional_steps(operation, rest)?;
        let result = if optional && let Some(cond) = nullish {
            self.var_defined = before.intersection(&self.var_defined).copied().collect();
            let result_type = self.optional_result_type(tail.ty(), node)?;
            let undefined = self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                result_type.clone(),
                node,
            )?;
            let tail = if tail.ty() != result_type && matches!(tail.ty(), Type::Union { .. }) {
                let value = self.coerce(tail, Type::Dyn, node)?;
                self.coerce(value, result_type.clone(), node)?
            } else {
                self.coerce(tail, result_type.clone(), node)?
            };
            Expr::Ternary {
                cond: Box::new(cond),
                then: Box::new(undefined),
                else_: Box::new(tail),
                r#type: result_type,
                loc: self.loc(node),
            }
        } else {
            tail
        };
        let ty = result.ty();
        Ok(Expr::Sequence {
            stmts: vec![Stmt::VarDecl {
                local_id: local.id,
                init: value,
                loc: self.loc(node),
            }],
            result: Box::new(result),
            r#type: ty,
            loc: self.loc(node),
        })
    }

    fn optional_receiver(&self, value: Expr, node: Node) -> Result<(Expr, Option<Expr>), String> {
        if value.ty() == Type::Dyn {
            let test = Expr::DynTest {
                value: Box::new(value.clone()),
                test: "nullish".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            };
            return Ok((value, Some(test)));
        }
        let Type::Union { union_id } = value.ty() else {
            return Ok((value, None));
        };
        let arms = &self.unions[union_id].arms;
        let present = arms
            .iter()
            .enumerate()
            .filter(|(_, ty)| !matches!(ty, Type::Null | Type::Undefined))
            .collect::<Vec<_>>();
        let [(tag, ty)] = present.as_slice() else {
            return Err(self.refuse(
                node,
                "optional access requires one represented non-null receiver arm",
            ));
        };
        let mut test = None;
        for (tag, arm) in arms.iter().enumerate() {
            if matches!(arm, Type::Null | Type::Undefined) {
                let is_tag = Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(value.clone()),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                };
                test = Some(if let Some(previous) = test {
                    Expr::Logical {
                        op: "||".into(),
                        left: Box::new(previous),
                        right: Box::new(is_tag),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }
                } else {
                    is_tag
                });
            }
        }
        let present = Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag: *tag,
            value: Box::new(value),
            r#type: (*ty).clone(),
            loc: self.loc(node),
        };
        Ok((present, test))
    }

    fn optional_key(&mut self, node: Node) -> Result<Expr, String> {
        if node.kind() == SyntaxKind::PropertyAccessExpression {
            return Ok(Expr::StrLit {
                value: node.name().text().into(),
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        self.property_key_expression(node.argument_expression())
    }

    fn optional_member_type(&mut self, node: Node, receiver: &Type) -> Result<Type, String> {
        if *receiver == Type::String {
            return self.string_index_type(node);
        }
        if *receiver == Type::Dyn {
            return Ok(Type::Dyn);
        }
        let Type::Record { shape_id } = *receiver else {
            return Err(self.refuse(
                node,
                "optional access receiver needs a native dictionary or data record",
            ));
        };
        let record = self.records[shape_id].clone();
        if record.tuple || self.callables.contains_key(&shape_id) || self.enum_shape(shape_id) {
            return Err(self.refuse(
                node,
                "optional tuple, callable and enum views require their native member contracts",
            ));
        }
        if let Some(value) = record.index_value {
            return self.undefined_storage_type(value, node);
        }
        let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
            Some(node.name().text().into())
        } else {
            self.literal_property_key(node.argument_expression())
        };
        let field = name.and_then(|name| record.fields.iter().find(|field| field.name == name));
        Ok(field.map_or(Type::Dyn, |field| field.r#type.clone()))
    }

    fn optional_member(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        if receiver.ty() == Type::String {
            return self.string_index(node, receiver);
        }
        let result_type = self.optional_member_type(node, &receiver.ty())?;
        let key = self.optional_key(node)?;
        if receiver.ty() == Type::Dyn {
            return Ok(self.dynamic_get(node, receiver, key));
        }
        let Type::Record { shape_id } = receiver.ty() else {
            unreachable!()
        };
        if self.records[shape_id].index_value.is_some() || result_type == Type::Dyn {
            return self.dictionary_get(node, receiver, key);
        }
        let Expr::StrLit { value: name, .. } = key else {
            return Err(self.refuse(
                node,
                "optional record access requires a known literal data field",
            ));
        };
        Ok(Expr::RecordGet {
            obj: Box::new(receiver),
            shape_id: format!("r{shape_id}"),
            field: name,
            r#type: result_type,
            loc: self.loc(node),
        })
    }
}
