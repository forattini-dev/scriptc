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
    Class {
        obj: Expr,
        class_name: String,
        field: String,
    },
    Dynamic {
        obj: Expr,
        key: Expr,
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
    /// Lower an array destructuring assignment while preserving the RHS and
    /// writing the already-declared bindings in source order. Assignment
    /// patterns use ArrayLiteralExpression/SpreadElement nodes rather than
    /// declaration BindingElements in the TypeScript AST.
    pub(super) fn array_assignment_expression(&mut self, node: Node) -> Result<Expr, String> {
        let pattern = primitives::primitive_source(node.left());
        if pattern.kind() != SyntaxKind::ArrayLiteralExpression {
            return Err(self.refuse(node, "array assignment requires an array pattern"));
        }
        let elements = pattern.elements().into_iter().collect::<Vec<_>>();
        for (index, element) in elements.iter().enumerate() {
            if element.kind() == SyntaxKind::OmittedExpression {
                continue;
            }
            let target = if element.kind() == SyntaxKind::SpreadElement {
                if index + 1 != elements.len() {
                    return Err(
                        self.refuse(*element, "array assignment rest target must be terminal")
                    );
                }
                element.expression()
            } else {
                *element
            };
            if target.kind() != SyntaxKind::Identifier {
                return Err(self.refuse(*element, "array assignment requires identifier targets"));
            }
        }

        let right = self.expression(node.right())?;
        let result_type = right.ty();
        let mut stmts = Vec::new();
        let result = self.update_temp(right, &mut stmts, node.right());
        let source = self.coerce(result.clone(), Type::Dyn, node.right())?;
        let source_local = self.construction_local(Type::Dyn, false);
        stmts.push(Stmt::VarDecl {
            local_id: source_local.id.clone(),
            init: source,
            loc: self.loc(pattern),
        });
        let has_rest = elements
            .last()
            .is_some_and(|element| element.kind() == SyntaxKind::SpreadElement);
        let items = self.construction_local(Type::Dyn, false);
        stmts.push(Stmt::VarDecl {
            local_id: items.id.clone(),
            init: Expr::DynIterN {
                value: Box::new(self.construction_read(&source_local, pattern)),
                count: elements.len() - usize::from(has_rest),
                r#type: Type::Dyn,
                loc: self.loc(pattern),
            },
            loc: self.loc(pattern),
        });

        for (index, element) in elements.into_iter().enumerate() {
            if element.kind() == SyntaxKind::OmittedExpression {
                continue;
            }
            let target = if element.kind() == SyntaxKind::SpreadElement {
                element.expression()
            } else {
                element
            };
            let symbol = self.symbol(target);
            let local = self.binding(target)?;
            if !local.mutable
                || local.r#type == Type::Caught
                || self.caught_aliases.contains_key(&symbol)
            {
                return Err(
                    self.refuse(target, "array assignment requires mutable native bindings")
                );
            }
            let target_type = self
                .var_types
                .get(&symbol)
                .cloned()
                .unwrap_or_else(|| local.r#type.clone());
            let value = if element.kind() == SyntaxKind::SpreadElement {
                let rest_type = if matches!(target_type, Type::Array { .. }) {
                    target_type.clone()
                } else if matches!(result_type, Type::Array { .. }) {
                    result_type.clone()
                } else {
                    Type::Array {
                        elem: Box::new(Type::Dyn),
                    }
                };
                self.sequence_array_rest(
                    self.construction_read(&source_local, element),
                    index,
                    element,
                    rest_type,
                )?
            } else {
                self.dynamic_get(
                    element,
                    self.construction_read(&items, element),
                    Expr::StrLit {
                        value: index.to_string(),
                        r#type: Type::String,
                        loc: self.loc(element),
                    },
                )
            };
            let selected = self.coerce(value, target_type, element)?;
            let stored = self.coerce(selected, local.r#type.clone(), element)?;
            if self.var_types.contains_key(&symbol) {
                self.var_assignment_fact(symbol, &stored);
            }
            stmts.push(Stmt::Assign {
                local_id: local.id,
                value: stored,
                initializes_global: false,
                loc: self.loc(element),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    /// Lower an object destructuring assignment as an ordered sequence of
    /// property reads and writes while retaining the original RHS value.
    /// Assignment patterns are represented by ObjectLiteralExpression nodes
    /// in the TypeScript AST (unlike declaration binding patterns).
    pub(super) fn object_assignment_expression(&mut self, node: Node) -> Result<Expr, String> {
        let pattern = primitives::primitive_source(node.left());
        if pattern.kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(node, "object assignment requires an object pattern"));
        }
        let properties = pattern.properties().into_iter().collect::<Vec<_>>();
        for property in &properties {
            if !matches!(
                property.kind(),
                SyntaxKind::ShorthandPropertyAssignment | SyntaxKind::PropertyAssignment
            ) {
                return Err(self.refuse(
                    *property,
                    "object assignment requires named identifier targets",
                ));
            }
            let target = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                property.name()
            } else {
                property.initializer()
            };
            if target.kind() != SyntaxKind::Identifier
                || self.data_property_name(property.name()).is_none()
            {
                return Err(self.refuse(
                    *property,
                    "object assignment requires named identifier targets",
                ));
            }
        }

        let right = self.expression(node.right())?;
        let result_type = right.ty();
        let mut stmts = Vec::new();
        let result = self.update_temp(right, &mut stmts, node.right());
        // Use the dynamic object protocol for the read. It preserves class
        // identity/getters and gives records and dictionaries the same JS
        // property semantics without inventing checker-only record layouts.
        let source = self.coerce(result.clone(), Type::Dyn, node.right())?;
        for property in properties {
            let target = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                property.name()
            } else {
                property.initializer()
            };
            let key = self.data_property_name(property.name()).unwrap();
            let value = self.dynamic_get(
                property,
                source.clone(),
                Expr::StrLit {
                    value: key,
                    r#type: Type::String,
                    loc: self.loc(property),
                },
            );
            let symbol = self.symbol(target);
            let local = self.binding(target)?;
            if !local.mutable
                || local.r#type == Type::Caught
                || self.caught_aliases.contains_key(&symbol)
            {
                return Err(
                    self.refuse(target, "object assignment requires mutable native bindings")
                );
            }
            let target_type = self
                .var_types
                .get(&symbol)
                .cloned()
                .unwrap_or_else(|| local.r#type.clone());
            let selected = self.coerce(value, target_type, property)?;
            let stored = self.coerce(selected, local.r#type.clone(), property)?;
            if self.var_types.contains_key(&symbol) {
                self.var_assignment_fact(symbol, &stored);
            }
            stmts.push(Stmt::Assign {
                local_id: local.id,
                value: stored,
                initializes_global: false,
                loc: self.loc(property),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn compound_numeric_operand(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        let Type::Union { union_id } = value.ty() else {
            return Ok(value);
        };
        let target = self.ty(node)?;
        if !matches!(target, Type::F64 | Type::Bigint) {
            return Ok(value);
        }
        let arms = &self.unions[union_id].arms;
        if arms.contains(&target)
            && arms
                .iter()
                .all(|arm| *arm == target || *arm == Type::Undefined)
        {
            // Planned optional fields keep their owning union ABI. A
            // TypeScript flow fact such as `field !== undefined` can still
            // select the numeric arm for this read; make that selection an
            // explicit checked IR operation before applying +=.
            return self.coerce(value, target, node);
        }
        Ok(value)
    }

    pub(super) fn nullish_assignment_expression(&mut self, node: Node) -> Result<Expr, String> {
        let operand = primitives::primitive_source(node.left());
        if operand.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(operand);
            let local = self.binding(operand)?;
            if !local.mutable
                || local.r#type == Type::Caught
                || self.caught_aliases.contains_key(&symbol)
            {
                return Err(self.refuse(
                    operand,
                    "nullish assignment requires a mutable native binding",
                ));
            }
            if local.r#type == Type::Dyn {
                let local_id = local.id.clone();
                let loc = self.loc(node);
                let operand_loc = self.loc(operand);
                let read = || Expr::VarRef {
                    local_id: local_id.clone(),
                    r#type: Type::Dyn,
                    loc: operand_loc.clone(),
                };
                let mut assigned = Vec::new();
                let right = self.expected_expression(node.right(), Type::Dyn)?;
                let right = self.update_temp(right, &mut assigned, node.right());
                assigned.push(Stmt::Assign {
                    local_id: local_id.clone(),
                    value: right.clone(),
                    initializes_global: false,
                    loc: self.loc(operand),
                });
                return Ok(Expr::Ternary {
                    cond: Box::new(Expr::DynTest {
                        value: Box::new(read()),
                        test: "nullish".into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: self.loc(operand),
                    }),
                    then: Box::new(Expr::Sequence {
                        stmts: assigned,
                        result: Box::new(right),
                        r#type: Type::Dyn,
                        loc: self.loc(node.right()),
                    }),
                    else_: Box::new(read()),
                    r#type: Type::Dyn,
                    loc,
                });
            }
            let Type::Union { union_id } = local.r#type else {
                return Err(self.refuse(
                    operand,
                    "local nullish assignment requires a represented nullable union",
                ));
            };
            let arms = self.unions[union_id].arms.clone();
            let present = arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                .collect::<Vec<_>>();
            let [(present_tag, present_type)] = present.as_slice() else {
                return Err(self.refuse(
                    operand,
                    "local nullish assignment requires one represented value arm",
                ));
            };
            if !arms.iter().all(|arm| {
                matches!(arm, Type::Null | Type::Undefined | Type::Void) || arm == *present_type
            }) {
                return Err(self.refuse(
                    operand,
                    "local nullish assignment has unsupported non-null union arms",
                ));
            }
            let local_id = local.id.clone();
            let local_type = local.r#type.clone();
            let operand_loc = self.loc(operand);
            let read = || Expr::VarRef {
                local_id: local_id.clone(),
                r#type: local_type.clone(),
                loc: operand_loc.clone(),
            };
            let mut nullish = None;
            for (tag, arm) in arms.iter().enumerate() {
                if !matches!(arm, Type::Null | Type::Undefined | Type::Void) {
                    continue;
                }
                let tagged = Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(read()),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(operand),
                };
                nullish = Some(if let Some(previous) = nullish {
                    Expr::Logical {
                        op: "||".into(),
                        left: Box::new(previous),
                        right: Box::new(tagged),
                        r#type: Type::Bool,
                        loc: self.loc(operand),
                    }
                } else {
                    tagged
                });
            }
            let right = self.expected_expression(node.right(), (*present_type).clone())?;
            let mut assigned = Vec::new();
            let right = self.update_temp(right, &mut assigned, node.right());
            let stored = self.coerce(right.clone(), local_type.clone(), node.right())?;
            assigned.push(Stmt::Assign {
                local_id: local_id.clone(),
                value: stored,
                initializes_global: false,
                loc: self.loc(operand),
            });
            let result_type = (*present_type).clone();
            return Ok(Expr::Ternary {
                cond: Box::new(nullish.expect("nullable union has a unit arm")),
                then: Box::new(Expr::Sequence {
                    stmts: assigned,
                    result: Box::new(right),
                    r#type: result_type.clone(),
                    loc: self.loc(node.right()),
                }),
                else_: Box::new(Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *present_tag,
                    value: Box::new(read()),
                    r#type: result_type.clone(),
                    loc: self.loc(operand),
                }),
                r#type: result_type,
                loc: self.loc(node),
            });
        }
        if !matches!(
            operand.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) || operand.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
            || (operand.kind() == SyntaxKind::PropertyAccessExpression
                && operand.name().kind() == SyntaxKind::PrivateIdentifier)
        {
            return Err(self.refuse(
                node,
                "nullish assignment currently requires a public dynamic property",
            ));
        }
        let receiver = self.expression(operand.expression())?;
        let receiver = self.live_member_receiver(operand.expression(), receiver);
        let receiver = self.coerce(receiver, Type::Dyn, operand.expression())?;
        let (key, key_node) = if operand.kind() == SyntaxKind::PropertyAccessExpression {
            (
                Expr::StrLit {
                    value: operand.name().text().into(),
                    r#type: Type::String,
                    loc: self.loc(operand.name()),
                },
                operand.name(),
            )
        } else {
            let source = operand.argument_expression();
            let key = self.expression(source)?;
            (self.coerce(key, Type::Dyn, source)?, source)
        };
        let mut stmts = Vec::new();
        let receiver = self.update_temp(receiver, &mut stmts, operand.expression());
        let key = self.update_temp(key, &mut stmts, key_node);
        let old = self.dynamic_get(node, receiver.clone(), key.clone());
        let old = self.update_temp(old, &mut stmts, node);

        // The RHS is built now but remains inside the selected sequence branch,
        // so its runtime effects stay lazy exactly as required by ??=.
        let right = self.expected_expression(node.right(), Type::Dyn)?;
        let mut assigned = Vec::new();
        let right = self.update_temp(right, &mut assigned, node.right());
        assigned.push(self.checked_dynamic_property_set(node, receiver, key, right.clone())?);
        let selected = Expr::Ternary {
            cond: Box::new(Expr::DynTest {
                value: Box::new(old.clone()),
                test: "nullish".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node.left()),
            }),
            then: Box::new(Expr::Sequence {
                stmts: assigned,
                result: Box::new(right),
                r#type: Type::Dyn,
                loc: self.loc(node.right()),
            }),
            else_: Box::new(old),
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(selected),
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }

    fn compound_class_assignment(&mut self, node: Node, op: &str) -> Result<Option<Expr>, String> {
        let operand = primitives::primitive_source(node.left());
        if !matches!(
            operand.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) || operand.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
            || (operand.kind() == SyntaxKind::PropertyAccessExpression
                && operand.name().kind() == SyntaxKind::PrivateIdentifier)
        {
            return Ok(None);
        }
        let object = self.expression(operand.expression())?;
        let object = self.live_member_receiver(operand.expression(), object);
        let ordinary_record_view = matches!(object.ty(), Type::Record { shape_id }
            if !self.records[shape_id].tuple
                && !self.enum_shape(shape_id)
                && !self.callables.contains_key(&shape_id));
        if object.ty() == Type::Dyn
            || ordinary_record_view
            || (operand.kind() == SyntaxKind::ElementAccessExpression
                && matches!(object.ty(), Type::Record { .. } | Type::Object { .. }))
        {
            let loc = self.loc(node);
            let mut stmts = Vec::new();
            let object = self.update_temp(object, &mut stmts, operand);
            let object = if ordinary_record_view {
                Expr::LibCall {
                    r#fn: "record.mutableDynView".into(),
                    args: vec![object],
                    r#type: Type::Dyn,
                    loc: self.loc(operand),
                }
            } else {
                self.coerce(object, Type::Dyn, operand)?
            };
            let key = if operand.kind() == SyntaxKind::PropertyAccessExpression {
                Expr::StrLit {
                    value: operand.name().text().into(),
                    r#type: Type::String,
                    loc: self.loc(operand),
                }
            } else {
                let source = operand.argument_expression();
                let key = self.expression(source)?;
                let key = self.coerce(key, Type::Dyn, source)?;
                self.update_temp(key, &mut stmts, source)
            };
            let old = self.dynamic_get(node, object.clone(), key.clone());
            let old = self.update_temp(old, &mut stmts, node);
            let right = self.primitive_operand(node.right())?;
            if !self.numeric_operand_domain(&right.ty()) && right.ty() != Type::Void {
                return Err(self.refuse(
                    node,
                    "dynamic compound property RHS requires a represented primitive",
                ));
            }
            let right = self.primitive_capture(right, node.right())?;
            let right = self.update_temp(right, &mut stmts, node);
            let value = self.numeric_binary(old, right, op, node)?;
            let result_type = value.ty();
            let value = self.update_temp(value, &mut stmts, node);
            let stored = self.coerce(value.clone(), Type::Dyn, node)?;
            stmts.push(self.checked_dynamic_property_set(node, object, key, stored)?);
            return Ok(Some(Expr::Sequence {
                stmts,
                result: Box::new(value),
                r#type: result_type,
                loc,
            }));
        }
        let Type::Object { class_name } = object.ty() else {
            return Ok(None);
        };
        let field = operand.name().text().to_string();
        let storage = self
            .ensure_contract_field(&class_name, &field, operand)?
            .ok_or_else(|| self.refuse(operand, "compound class field is not represented"))?;
        let selected = self.ty(operand).ok().and_then(|selected| {
            let Type::Union { union_id } = &storage else {
                return None;
            };
            let arms = &self.unions[*union_id].arms;
            (matches!(selected, Type::F64 | Type::Bigint | Type::String)
                && arms.contains(&selected)
                && arms
                    .iter()
                    .all(|arm| *arm == selected || matches!(arm, Type::Null | Type::Undefined)))
            .then_some(selected)
        });
        let operation = selected.unwrap_or_else(|| storage.clone());
        let string = storage == Type::String
            || matches!(storage, Type::Union { union_id }
            if self.unions[union_id].arms.contains(&Type::String)
                && self.unions[union_id].arms.iter().all(|arm| {
                    matches!(arm, Type::String | Type::Null | Type::Undefined)
                }));
        let numeric = |ty: &Type| {
            matches!(ty, Type::F64 | Type::Bigint | Type::Dyn)
                || matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.iter().any(|arm| matches!(arm, Type::F64 | Type::Bigint)) && self.unions[*union_id].arms.iter().all(|arm| matches!(arm, Type::F64 | Type::Bigint | Type::Undefined)))
        };
        if !(numeric(&operation) || op == "+" && string) {
            return Err(self.refuse(
                node,
                "compound class assignment requires numeric, erased primitive, or string += storage",
            ));
        }
        let loc = self.loc(node);
        let mut stmts = Vec::new();
        let object = self.update_temp(object, &mut stmts, operand);
        let old = self.update_temp(
            Expr::FieldGet {
                obj: Box::new(object.clone()),
                class_name: class_name.clone(),
                field: field.clone(),
                r#type: storage.clone(),
                loc: loc.clone(),
            },
            &mut stmts,
            node,
        );
        let old = if operation != storage && !string {
            self.coerce(old, operation.clone(), operand)?
        } else {
            old
        };
        let right = self.primitive_operand(node.right())?;
        let right = self.compound_numeric_operand(right, node.right())?;
        let right_numeric = self.numeric_operand_domain(&right.ty()) || right.ty() == Type::Void;
        let right_stringable = !self.native_type_contains(&right.ty(), |ty| {
            !matches!(
                ty,
                Type::String
                    | Type::Bigint
                    | Type::F64
                    | Type::Bool
                    | Type::Null
                    | Type::Undefined
                    | Type::Void
                    | Type::Dyn
                    | Type::Union { .. }
            )
        });
        if (string && !right_stringable) || (!string && !right_numeric) {
            return Err(self.refuse(node, "compound class operand domain is not ported"));
        }
        let right = self.primitive_capture(right, node.right())?;
        let right = if string {
            self.string_value(right, node.right(), strings::Context::Template)?
        } else if storage == Type::F64
            && right.ty() == Type::Dyn
            && self.ty(node.right()).ok() == Some(Type::F64)
        {
            // A destructured field from an erased JavaScript record can keep
            // its numeric checker view even though the owning record crosses
            // NativeValue. Check that projection before `+=`; this excludes
            // string concatenation without trusting the erased payload.
            self.coerce(right, Type::F64, node.right())?
        } else {
            right
        };
        let right = self.update_temp(right, &mut stmts, node);
        if op == "+"
            && operation != Type::Dyn
            && !string
            && self.numeric_domain(&right.ty(), true) & 4 != 0
        {
            return Err(self.refuse(
                node,
                "compound += operand may change numeric class storage to string",
            ));
        }
        let value = if string {
            let old = self.string_value(old, operand, strings::Context::Template)?;
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
        let stored = self.coerce(value.clone(), storage, node)?;
        stmts.push(Stmt::FieldSet {
            obj: object,
            class_name,
            field,
            value: stored,
            loc: loc.clone(),
        });
        Ok(Some(Expr::Sequence {
            stmts,
            result: Box::new(value),
            r#type: result_type,
            loc,
        }))
    }

    /// Evaluate the reference once, then the RHS, then perform the write.
    /// The assignment expression returns the original RHS value, not a readback.
    pub(super) fn dynamic_element_assignment_expression(
        &mut self,
        node: Node,
    ) -> Result<Expr, String> {
        self.guard_raw_json_write(node)?;
        let member = primitives::primitive_source(node.left());
        if member.kind() != SyntaxKind::ElementAccessExpression
            || !member.question_dot_token().is_nil()
        {
            return Err(self.refuse(
                node,
                "assignment expression requires a native property reference",
            ));
        }
        let receiver = self.expression(member.expression())?;
        let receiver = self.live_member_receiver(member.expression(), receiver);
        if let Type::Array { elem } = receiver.ty() {
            let storage = (*elem).clone();
            let loc = self.loc(node);
            let mut stmts = Vec::new();
            let receiver = self.update_temp(receiver, &mut stmts, member.expression());
            let index = self.expected_expression(member.argument_expression(), Type::F64)?;
            let index = self.update_temp(index, &mut stmts, member.argument_expression());
            let value = self.expected_expression(node.right(), storage.clone())?;
            let result_type = value.ty();
            let result = self.update_temp(value, &mut stmts, node.right());
            let stored = self.coerce(result.clone(), storage, node.right())?;
            stmts.push(self.source_array_set(node, receiver, index, stored));
            return Ok(Expr::Sequence {
                stmts,
                result: Box::new(result),
                r#type: result_type,
                loc,
            });
        }
        let receiver = match receiver.ty() {
            Type::Dyn => receiver,
            Type::Record { shape_id }
                if !self.records[shape_id].tuple
                    && !self.enum_shape(shape_id)
                    && !self.callables.contains_key(&shape_id) =>
            {
                // Ordinary records and their erased view share the same
                // property store. A computed assignment can therefore update
                // an existing field or create an expando without copying the
                // object; subsequent typed reads validate the live slot.
                self.coerce(receiver, Type::Dyn, member.expression())?
            }
            _ => {
                return Err(self.refuse(
                    member,
                    "computed assignment expressions require an erased or ordinary record receiver",
                ));
            }
        };
        let key = self.expression(member.argument_expression())?;
        let key = self.coerce(key, Type::Dyn, member.argument_expression())?;
        let value = self.expected_expression(node.right(), Type::Dyn)?;
        let mut stmts = Vec::new();
        let receiver = self.update_temp(receiver, &mut stmts, member);
        let key = self.update_temp(key, &mut stmts, member);
        let result = self.update_temp(value, &mut stmts, node);
        stmts.push(self.checked_dynamic_property_set(node, receiver, key, result.clone())?);
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }

    pub(super) fn logical_assignment_expression(&mut self, node: Node) -> Result<Expr, String> {
        let operand = primitives::primitive_source(node.left());
        if operand.kind() != SyntaxKind::Identifier {
            return Err(self.refuse(
                node,
                "logical assignment currently requires a mutable local binding",
            ));
        }
        let symbol = self.symbol(operand);
        let local = self.binding(operand)?;
        if !local.mutable
            || local.r#type == Type::Caught
            || self.caught_aliases.contains_key(&symbol)
        {
            return Err(self.refuse(
                operand,
                "logical assignment requires a mutable native binding",
            ));
        }

        // Read the owning cell for the condition. The RHS and write live in
        // only one ternary arm, preserving JavaScript short-circuiting.
        let read = Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(operand),
        };
        let cond = self.condition(read.clone(), operand)?;
        let target = self
            .var_types
            .get(&symbol)
            .cloned()
            .unwrap_or_else(|| local.r#type.clone());
        let value = self.expected_expression(node.right(), target)?;
        let result_type = value.ty();
        let mut assigned = Vec::new();
        let result = self.update_temp(value, &mut assigned, node.right());
        let stored = self.coerce(result.clone(), local.r#type.clone(), node.right())?;
        if self.var_types.contains_key(&symbol) {
            self.var_assignment_fact(symbol, &stored);
        }
        assigned.push(Stmt::Assign {
            local_id: local.id,
            value: stored,
            initializes_global: false,
            loc: self.loc(operand),
        });
        let assignment = Expr::Sequence {
            stmts: assigned,
            result: Box::new(result),
            r#type: result_type.clone(),
            loc: self.loc(node.right()),
        };
        let retained = self.coerce(read, result_type.clone(), operand)?;
        let (then, else_) = match node.operator_token().kind() {
            SyntaxKind::BarBarEqualsToken => (retained, assignment),
            SyntaxKind::AmpersandAmpersandEqualsToken => (assignment, retained),
            _ => unreachable!("logical assignment dispatch validates the operator"),
        };
        Ok(Expr::Ternary {
            cond: Box::new(cond),
            then: Box::new(then),
            else_: Box::new(else_),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn local_assignment_expression(&mut self, node: Node) -> Result<Expr, String> {
        let operand = primitives::primitive_source(node.left());
        if operand.kind() != SyntaxKind::Identifier {
            return Err(self.refuse(
                node,
                "assignment expression requires a mutable local binding",
            ));
        }
        let symbol = self.symbol(operand);
        if self.enum_type(operand).is_some() || self.native_namespaces.contains_key(&symbol) {
            return Err(self.refuse(node, "namespace assignment expressions are not ported"));
        }
        let local = self.binding(operand)?;
        if !local.mutable
            || local.r#type == Type::Caught
            || self.caught_aliases.contains_key(&symbol)
        {
            return Err(self.refuse(
                node,
                "assignment expression requires a mutable native binding",
            ));
        }
        let target = self
            .var_types
            .get(&symbol)
            .cloned()
            .unwrap_or_else(|| local.r#type.clone());
        let value = self.expected_expression(node.right(), target)?;
        let result_type = value.ty();
        let mut stmts = Vec::new();
        let result = self.update_temp(value, &mut stmts, node);
        let stored = self.coerce(result.clone(), local.r#type.clone(), node)?;
        if self.var_types.contains_key(&symbol) {
            self.var_assignment_fact(symbol, &stored);
        }
        stmts.push(Stmt::Assign {
            local_id: local.id,
            value: stored,
            initializes_global: false,
            loc: self.loc(node),
        });
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    /// Property assignment used as a value preserves JavaScript evaluation
    /// order and returns the assigned RHS without reading the property back.
    pub(super) fn property_assignment_expression(&mut self, node: Node) -> Result<Expr, String> {
        self.guard_raw_json_write(node)?;
        let member = primitives::primitive_source(node.left());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
        {
            return Err(self.refuse(
                node,
                "assignment expression requires a native property reference",
            ));
        }
        let receiver = self.expression(member.expression())?;
        let receiver = self.live_member_receiver(member.expression(), receiver);
        let name = member.name().text().to_string();
        if name == "__proto__" {
            return Err(self.refuse(member, "ordinary prototype writes are not ported"));
        }
        let mut stmts = Vec::new();
        let receiver = self.update_temp(receiver, &mut stmts, member);
        enum Write {
            Record { shape_id: usize, field: String },
            Object { class_name: String, field: String },
            Dynamic { key: Expr },
        }
        let (target, write) = match receiver.ty() {
            Type::Record { shape_id } => {
                let field = self.records[shape_id]
                    .fields
                    .iter()
                    .find(|field| field.name == name)
                    .cloned();
                if let Some(field) = field {
                    let field_name = field.name.clone();
                    (
                        field.r#type,
                        Write::Record {
                            shape_id,
                            field: field_name,
                        },
                    )
                } else if !self.records[shape_id].tuple
                    && !self.enum_shape(shape_id)
                    && !self.callables.contains_key(&shape_id)
                {
                    (
                        Type::Dyn,
                        Write::Dynamic {
                            key: Expr::StrLit {
                                value: name.clone(),
                                r#type: Type::String,
                                loc: self.loc(member),
                            },
                        },
                    )
                } else {
                    return Err(self.refuse(member, "unknown native record field"));
                }
            }
            Type::Object { ref class_name } => {
                let target =
                    if let Some(target) = self.ensure_contract_field(class_name, &name, member)? {
                        target
                    } else {
                        self.ensure_dynamic_class_field(class_name, &name, member)?
                    };
                (
                    target,
                    Write::Object {
                        class_name: class_name.clone(),
                        field: name.clone(),
                    },
                )
            }
            Type::Dyn => {
                let key = Expr::StrLit {
                    value: name,
                    r#type: Type::String,
                    loc: self.loc(member),
                };
                (Type::Dyn, Write::Dynamic { key })
            }
            _ => {
                return Err(
                    self.refuse(member, "assignment expression requires an object receiver")
                );
            }
        };
        let value = self.expected_expression(node.right(), target)?;
        let result_type = value.ty();
        let result = self.update_temp(value, &mut stmts, node);
        let write = match write {
            Write::Record { shape_id, field } => Stmt::RecordSet {
                obj: receiver,
                shape_id: format!("r{shape_id}"),
                field,
                value: result.clone(),
                loc: self.loc(node),
            },
            Write::Object { class_name, field } => Stmt::FieldSet {
                obj: receiver,
                class_name,
                field,
                value: result.clone(),
                loc: self.loc(node),
            },
            Write::Dynamic { key } => {
                let receiver = self.coerce(receiver, Type::Dyn, member)?;
                self.checked_dynamic_property_set(node, receiver, key, result.clone())?
            }
        };
        stmts.push(write);
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn compound_assignment(&mut self, node: Node, op: &str) -> Result<Expr, String> {
        if let Some(value) = self.array_compound_assignment(node, op)? {
            return Ok(value);
        }
        if let Some(value) = self.bytes_assignment(node, Some(op))? {
            return Ok(value);
        }
        if let Some(value) = self.record_compound_assignment(node, op)? {
            return Ok(value);
        }
        if let Some(value) = self.compound_class_assignment(node, op)? {
            return Ok(value);
        }
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
        let string = storage == Type::String
            || matches!(storage, Type::Union { union_id } if self.unions[union_id].arms.contains(&Type::String) && self.unions[union_id].arms.iter().all(|arm| matches!(arm, Type::String | Type::Undefined)));
        if !local.mutable || !(numeric(&storage) || op == "+" && string) {
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
        let right = self.compound_numeric_operand(right, node.right())?;
        let right_numeric = self.numeric_operand_domain(&right.ty()) || right.ty() == Type::Void;
        let right_stringable = !self.native_type_contains(&right.ty(), |ty| {
            !matches!(
                ty,
                Type::String
                    | Type::Bigint
                    | Type::F64
                    | Type::Bool
                    | Type::Null
                    | Type::Undefined
                    | Type::Void
                    | Type::Dyn
                    | Type::Union { .. }
            )
        });
        if (string && !right_stringable) || (!string && !right_numeric) {
            return Err(self.refuse(
                node,
                &format!(
                    "compound operand domain is not ported; numeric bindings require primitives and string += requires string: storage={storage:?}, right={:?}",
                    right.ty()
                ),
            ));
        }
        let right = self.primitive_capture(right, node.right())?;
        let right = if string {
            self.string_value(right, node.right(), strings::Context::Template)?
        } else if storage == Type::F64
            && right.ty() == Type::Dyn
            && self.ty(node.right()).ok() == Some(Type::F64)
        {
            // A destructured field from an erased JavaScript record can keep
            // its numeric checker view even though the owning record crosses
            // NativeValue. Check that projection before `+=`; this excludes
            // string concatenation without trusting the erased payload.
            self.coerce(right, Type::F64, node.right())?
        } else {
            right
        };
        let right = self.update_temp(right, &mut stmts, node);
        // Conversions belong after RHS GetValue. Typed numeric += cannot
        // publish a string into its already allocated storage contract.
        if op == "+"
            && storage != Type::Dyn
            && !string
            && self.numeric_domain(&right.ty(), true) & 4 != 0
        {
            let checked = self.ty(node.right()).ok();
            return Err(self.refuse(
                node,
                &format!(
                    "compound += operand may change numeric storage to string: storage={storage:?}, right={:?}, checker={checked:?}",
                    right.ty()
                ),
            ));
        }
        let value = if string {
            let old = self.string_value(old, operand, strings::Context::Template)?;
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

    fn record_compound_assignment(&mut self, node: Node, op: &str) -> Result<Option<Expr>, String> {
        let operand = primitives::primitive_source(node.left());
        if operand.kind() != SyntaxKind::PropertyAccessExpression
            || operand.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
            || operand.name().kind() == SyntaxKind::PrivateIdentifier
        {
            return Ok(None);
        }
        let receiver = self.expression(operand.expression())?;
        let receiver = self.live_member_receiver(operand.expression(), receiver);
        let (shape_id, nullable) = match receiver.ty() {
            Type::Record { shape_id } => (shape_id, None),
            _ => match self.nullable_record(&receiver.ty()) {
                Some((union_id, tag, shape_id)) => (shape_id, Some((union_id, tag))),
                None => return Ok(None),
            },
        };
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|field| field.name == operand.name().text())
            .cloned();
        let Some(field) = field else {
            return Ok(None);
        };
        let storage = field.r#type.clone();
        let numeric = matches!(storage, Type::F64 | Type::Bigint | Type::Dyn);
        let string = storage == Type::String && op == "+";
        if !numeric && !string {
            return Err(self.refuse(
                node,
                "record compound assignment requires a numeric field or string += field",
            ));
        }
        let loc = self.loc(node);
        let mut stmts = Vec::new();
        let receiver = self.update_temp(receiver, &mut stmts, operand.expression());
        let write_receiver = if let Some((union_id, tag)) = nullable {
            Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(receiver.clone()),
                r#type: Type::Record { shape_id },
                loc: loc.clone(),
            }
        } else {
            receiver.clone()
        };
        let old = if nullable.is_some() {
            self.nullable_record_get(operand, receiver.clone())?
        } else {
            Expr::RecordGet {
                obj: Box::new(receiver.clone()),
                shape_id: format!("r{shape_id}"),
                field: field.name.clone(),
                r#type: storage.clone(),
                loc: loc.clone(),
            }
        };
        let old = self.update_temp(old, &mut stmts, operand);
        let right = self.primitive_operand(node.right())?;
        let right = self.compound_numeric_operand(right, node.right())?;
        if (string && !matches!(right.ty(), Type::String | Type::Dyn))
            || (!string && !self.numeric_operand_domain(&right.ty()))
        {
            return Err(self.refuse(
                node,
                "record compound assignment operand domain is not ported",
            ));
        }
        let right = self.primitive_capture(right, node.right())?;
        let right = if string && right.ty() == Type::Dyn {
            self.coerce(right, Type::String, node.right())?
        } else {
            right
        };
        let right = self.update_temp(right, &mut stmts, node.right());
        let value = if string {
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
        let stored = self.coerce(value.clone(), storage, node)?;
        stmts.push(Stmt::RecordSet {
            obj: write_receiver,
            shape_id: format!("r{shape_id}"),
            field: field.name,
            value: stored,
            loc: loc.clone(),
        });
        Ok(Some(Expr::Sequence {
            stmts,
            result: Box::new(value),
            r#type: result_type,
            loc,
        }))
    }

    fn array_compound_assignment(&mut self, node: Node, op: &str) -> Result<Option<Expr>, String> {
        let operand = primitives::primitive_source(node.left());
        if operand.kind() != SyntaxKind::ElementAccessExpression
            || operand.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        {
            return Ok(None);
        }
        let receiver_node = operand.expression();
        let symbol = if receiver_node.kind() == SyntaxKind::Identifier {
            self.symbol(receiver_node)
        } else {
            0
        };
        let receiver_type = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .map(|local| local.r#type.clone())
            .or_else(|| self.ty(receiver_node).ok());
        let represented_array = receiver_type.as_ref().is_some_and(|ty| self.array_view(ty))
            || matches!(receiver_type, Some(Type::Dyn)) && {
                let mut probe = self.diagnostic_fork();
                probe
                    .expression(receiver_node)
                    .is_ok_and(|value| probe.array_view(&value.ty()))
            };
        if !represented_array {
            return Ok(None);
        }
        let receiver = self.expression(receiver_node)?;
        let Type::Array { elem } = receiver.ty() else {
            return Ok(None);
        };
        let storage = (*elem).clone();
        let string = storage == Type::String && op == "+";
        if !matches!(storage, Type::F64 | Type::Dyn) && !string {
            return Err(self.refuse(
                node,
                &format!(
                    "indexed compound assignment currently requires a native numeric, erased, or string += array: storage={storage:?}"
                ),
            ));
        }

        let loc = self.loc(node);
        let mut stmts = Vec::new();
        let receiver = self.update_temp(receiver, &mut stmts, operand.expression());
        let index = self.expected_expression(operand.argument_expression(), Type::F64)?;
        let index = self.update_temp(index, &mut stmts, operand.argument_expression());
        // GetValue precedes every effect in the right-hand side, while the
        // captured receiver and index are reused by PutValue afterwards.
        let old = Expr::ArrayGet {
            arr: Box::new(receiver.clone()),
            index: Box::new(index.clone()),
            r#type: storage.clone(),
            loc: loc.clone(),
        };
        let old = if storage == Type::F64 {
            self.coerce(old, Type::F64, operand)?
        } else {
            old
        };
        let old = self.update_temp(old, &mut stmts, operand);
        let right = self.primitive_operand(node.right())?;
        let right = self.compound_numeric_operand(right, node.right())?;
        let right_stringable = !self.native_type_contains(&right.ty(), |ty| {
            !matches!(
                ty,
                Type::String
                    | Type::Bigint
                    | Type::F64
                    | Type::Bool
                    | Type::Null
                    | Type::Undefined
                    | Type::Void
                    | Type::Dyn
                    | Type::Union { .. }
            )
        });
        if string && !right_stringable || !string && !self.numeric_operand_domain(&right.ty()) {
            return Err(self.refuse(
                node,
                "array compound assignment requires a compatible primitive right operand",
            ));
        }
        let right = self.primitive_capture(right, node.right())?;
        let right = if string {
            self.string_value(right, node.right(), strings::Context::Template)?
        } else {
            right
        };
        let right = self.update_temp(right, &mut stmts, node.right());
        let result = if string {
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
        let result_type = result.ty();
        let result = self.update_temp(result, &mut stmts, node);
        let stored = self.coerce(result.clone(), storage, node)?;
        stmts.push(self.source_array_set(node, receiver, index, stored));
        Ok(Some(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: result_type,
            loc,
        }))
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
                if operand.kind() == SyntaxKind::ElementAccessExpression
                    && self
                        .class_symbol_key(operand.argument_expression())
                        .is_some()
                {
                    let obj = self.expression(operand.expression())?;
                    if !matches!(
                        obj.ty(),
                        Type::Object { .. } | Type::Dyn | Type::Union { .. }
                    ) {
                        return Err(self.refuse(
                            node,
                            "computed symbol updates require a represented class instance or dynamic object",
                        ));
                    }
                    let obj = self.coerce(obj, Type::Dyn, operand.expression())?;
                    let obj = self.update_temp(obj, &mut stmts, operand.expression());
                    let key = self.expression(operand.argument_expression())?;
                    let key = self.update_temp(key, &mut stmts, operand.argument_expression());
                    let value = Expr::DynKeyGet {
                        value: Box::new(obj.clone()),
                        key: Box::new(key.clone()),
                        r#type: Type::Dyn,
                        loc: self.loc(operand),
                    };
                    (Target::Dynamic { obj, key }, value, Type::Dyn)
                } else {
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
                    let mut obj = self.expression(operand.expression())?;
                    if operand.expression().kind() == SyntaxKind::NonNullExpression
                        && let Type::Union { union_id } = obj.ty()
                    {
                        let present = self.unions[union_id]
                            .arms
                            .iter()
                            .enumerate()
                            .filter(|(_, arm)| {
                                !matches!(arm, Type::Null | Type::Undefined | Type::Void)
                            })
                            .map(|(tag, arm)| (tag, arm.clone()))
                            .collect::<Vec<_>>();
                        if let [(tag, target)] = present.as_slice()
                            && self.unions[union_id].arms.iter().all(|arm| {
                                arm == target
                                    || matches!(arm, Type::Null | Type::Undefined | Type::Void)
                            })
                        {
                            obj = Expr::UnionNarrow {
                                union_id: format!("u{union_id}"),
                                tag: *tag,
                                value: Box::new(obj),
                                r#type: target.clone(),
                                loc: self.loc(operand.expression()),
                            };
                        }
                    }
                    if obj.ty() == Type::Dyn
                        && operand.kind() == SyntaxKind::PropertyAccessExpression
                    {
                        let obj = self.update_temp(obj, &mut stmts, operand.expression());
                        let key = Expr::StrLit {
                            value: name,
                            r#type: Type::String,
                            loc: self.loc(operand),
                        };
                        let value = self.dynamic_get(node, obj.clone(), key.clone());
                        (Target::Dynamic { obj, key }, value, Type::Dyn)
                    } else if let Type::Object { class_name } = obj.ty() {
                        if operand.kind() != SyntaxKind::PropertyAccessExpression {
                            return Err(self
                                .refuse(node, "computed class update references are not ported"));
                        }
                        let storage = self
                            .ensure_contract_field(&class_name, &name, operand)?
                            .ok_or_else(|| {
                                self.refuse(operand, "class update field is not represented")
                            })?;
                        let obj = self.update_temp(obj, &mut stmts, node);
                        let value = Expr::FieldGet {
                            obj: Box::new(obj.clone()),
                            class_name: class_name.clone(),
                            field: name.clone(),
                            r#type: storage.clone(),
                            loc: loc.clone(),
                        };
                        (
                            Target::Class {
                                obj,
                                class_name,
                                field: name,
                            },
                            value,
                            storage,
                        )
                    } else {
                        let Type::Record { shape_id } = obj.ty() else {
                            return Err(self.refuse(
                            node,
                            &format!(
                                "update reference requires a closed native record or represented class field; indexed containers are not ported; found {:?}",
                                obj.ty()
                            ),
                        ));
                        };
                        if self.enum_shape(shape_id)
                            || self.callables.contains_key(&shape_id)
                            || self.records[shape_id].index_value.is_some()
                            || name == "__proto__"
                        {
                            return Err(self.refuse(
                                node,
                                "update requires an ordinary closed record data field",
                            ));
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
                }
            }
            _ => return Err(self.refuse(node, "update operand has no native writable reference")),
        };
        // Numeric cells can retain an undefined tag after hoisting or a call.
        // Other source domains also require flow invalidation for subsequent
        // reads, so do not admit them just because conversion can produce f64.
        let flow_number = storage == Type::Dyn && self.ty(node).is_ok_and(|ty| ty == Type::F64);
        let numeric = flow_number
            || storage == Type::F64
            || matches!(&storage, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::F64) && self.unions[*union_id].arms.iter().all(|arm| matches!(arm, Type::F64 | Type::Undefined)));
        if !numeric {
            let storage = match &storage {
                Type::Union { union_id } => {
                    format!("union u{union_id} {:?}", self.unions[*union_id].arms)
                }
                storage => format!("{storage:?}"),
            };
            return Err(self.refuse(node, &format!("updates require number or undefined-capable numeric storage; found {storage}; other ToNumeric domains are not ported")));
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
            Target::Class {
                obj,
                class_name,
                field,
            } => Stmt::FieldSet {
                obj,
                class_name,
                field,
                value: stored,
                loc: loc.clone(),
            },
            Target::Dynamic { obj, key } => {
                self.checked_dynamic_property_set(node, obj, key, stored)?
            }
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

    pub(super) fn update_temp(&mut self, init: Expr, stmts: &mut Vec<Stmt>, node: Node) -> Expr {
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
