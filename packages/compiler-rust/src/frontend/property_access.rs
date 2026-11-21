//! Property references retain live nullish tags and source evaluation order.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn nullable_record(&self, ty: &Type) -> Option<(usize, usize, usize)> {
        let Type::Union { union_id } = ty else {
            return None;
        };
        let mut record = None;
        let mut nullish = false;
        for (tag, arm) in self.unions[*union_id].arms.iter().enumerate() {
            match arm {
                Type::Null | Type::Undefined => nullish = true,
                Type::Record { shape_id } if record.is_none() => {
                    record = Some((*union_id, tag, *shape_id))
                }
                _ => return None,
            }
        }
        record.filter(|_| nullish)
    }

    fn property_nullish_guards(
        &mut self,
        helper: &mut Helper,
        setting: bool,
        node: Node,
    ) -> Result<(), String> {
        self.ensure_exception_classes(node)?;
        let input = helper.param(0);
        let key = helper.param(1);
        for (unit, ty) in [("undefined", Type::Undefined), ("null", Type::Null)] {
            let cond = match input.r#type {
                Type::Dyn => Expr::DynTest {
                    value: Box::new(helper.read(&input)),
                    test: unit.into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                Type::Union { union_id } => {
                    let Some(tag) = self.unions[union_id].arms.iter().position(|arm| *arm == ty)
                    else {
                        continue;
                    };
                    Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        value: Box::new(helper.read(&input)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }
                }
                _ => unreachable!(),
            };
            let string = |value: String| Expr::StrLit {
                value,
                r#type: Type::String,
                loc: helper.loc(),
            };
            let key_text = if key.r#type == Type::Dyn {
                Expr::LibCall {
                    r#fn: "dyn.stringConstructor".into(),
                    args: vec![helper.read(&key)],
                    r#type: Type::String,
                    loc: helper.loc(),
                }
            } else {
                helper.read(&key)
            };
            let message = self.string_concat(
                self.string_concat(
                    string(format!(
                        "Cannot {} properties of {unit} ({} '",
                        if setting { "set" } else { "read" },
                        if setting { "setting" } else { "reading" }
                    )),
                    key_text,
                    node,
                ),
                string("')".into()),
                node,
            );
            helper.function.body.push(Stmt::If {
                cond,
                then: vec![Stmt::Throw {
                    value: Expr::LibCall {
                        r#fn: "error.new".into(),
                        args: vec![message],
                        r#type: Type::Object {
                            class_name: "%TypeError".into(),
                        },
                        loc: helper.loc(),
                    },
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        Ok(())
    }

    pub(super) fn checked_dynamic_property_set(
        &mut self,
        node: Node,
        obj: Expr,
        key: Expr,
        value: Expr,
    ) -> Result<Stmt, String> {
        let target = if node.kind() == SyntaxKind::BinaryExpression {
            Some(node.left())
        } else if matches!(
            node.kind(),
            SyntaxKind::PrefixUnaryExpression | SyntaxKind::PostfixUnaryExpression
        ) {
            Some(node.operand())
        } else {
            None
        };
        if let Some(target) = target
            && !target.is_nil()
            && matches!(
                target.kind(),
                SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
            )
        {
            let source = primitives::primitive_source(target.expression());
            if matches!(self.ty(source), Ok(Type::Set { .. })) {
                return Err(self.refuse(
                    target,
                    "erased Set property writes require native descriptor storage",
                ));
            }
            if matches!(self.ty(source), Ok(Type::Map { .. })) {
                return Err(self.refuse(
                    target,
                    "erased Map property writes require native descriptor storage",
                ));
            }
        }
        let computed = matches!(key.ty(), Type::Symbol | Type::Dyn);
        let strict = receivers::strict(node);
        let key = if computed {
            self.coerce(key, Type::Dyn, node)?
        } else {
            key
        };
        let mut helper = Helper::new(
            if strict {
                "property_write"
            } else {
                "property_write_sloppy"
            },
            vec![
                Type::Dyn,
                if computed { Type::Dyn } else { Type::String },
                Type::Dyn,
            ],
            Type::Void,
            self.loc(node),
        );
        self.property_nullish_guards(&mut helper, true, node)?;
        helper.function.body.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: match (computed, strict) {
                    (true, true) => "dyn.keySetComputed",
                    (false, true) => "dyn.keySet",
                    (true, false) => "dyn.keySetComputedSloppy",
                    (false, false) => "dyn.keySetSloppy",
                }
                .into(),
                args: (0..3).map(|i| helper.read(&helper.param(i))).collect(),
                r#type: Type::Void,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        Ok(Stmt::Expression {
            expr: Expr::Call {
                callee: self.install_helper(helper.function),
                args: vec![obj, key, value],
                r#type: Type::Void,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        })
    }

    fn nullable_field(
        &self,
        node: Node,
        obj: &Expr,
        name: &str,
    ) -> Result<(usize, usize, usize, ir::Field), String> {
        let (union, tag, shape) = self.nullable_record(&obj.ty()).unwrap();
        let record = &self.records[shape];
        if record.tuple || self.enum_shape(shape) {
            return Err(self.refuse(
                node,
                "nullable property references require an ordinary named record field",
            ));
        }
        let field = record
            .fields
            .iter()
            .find(|field| field.name == name)
            .cloned()
            .ok_or_else(|| self.refuse(node, "unknown native record field"))?;
        Ok((union, tag, shape, field))
    }

    pub(super) fn nullable_record_get(&mut self, node: Node, obj: Expr) -> Result<Expr, String> {
        let name = node.name().text();
        if let Some((union, tag, shape)) = self.nullable_record(&obj.ty())
            && let Some(stored) = self.records[shape].index_value.clone()
            && !self.records[shape]
                .fields
                .iter()
                .any(|field| field.name == name)
        {
            let result = self.lookup_type(stored, node)?;
            let mut helper = Helper::new(
                &format!(
                    "property_read_index_r{shape}_{}",
                    name.as_bytes()
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                ),
                vec![obj.ty(), Type::String],
                result.clone(),
                self.loc(node),
            );
            self.property_nullish_guards(&mut helper, false, node)?;
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::RecordKeyGet {
                    obj: Box::new(Expr::UnionNarrow {
                        union_id: format!("u{union}"),
                        tag,
                        value: Box::new(helper.read(&helper.param(0))),
                        r#type: Type::Record { shape_id: shape },
                        loc: helper.loc(),
                    }),
                    shape_id: format!("r{shape}"),
                    key: Box::new(helper.read(&helper.param(1))),
                    overflow_only: true,
                    r#type: result.clone(),
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Expr::Call {
                callee: self.install_helper(helper.function),
                args: vec![
                    obj,
                    Expr::StrLit {
                        value: name.into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                ],
                r#type: result,
                loc: self.loc(node),
            });
        }
        if let Some((union, tag, shape)) = self.nullable_record(&obj.ty())
            && !self.records[shape].tuple
            && !self.enum_shape(shape)
            && !self.callables.contains_key(&shape)
            && !self.records[shape]
                .fields
                .iter()
                .any(|field| field.name == name)
        {
            // Plain records own an expando property store. Keep the source
            // nullish check, then read a field added after the original
            // literal without manufacturing a second record identity.
            let mut helper = Helper::new(
                "nullable_record_expando_read",
                vec![obj.ty(), Type::String],
                Type::Dyn,
                self.loc(node),
            );
            self.property_nullish_guards(&mut helper, false, node)?;
            let narrowed = Expr::UnionNarrow {
                union_id: format!("u{union}"),
                tag,
                value: Box::new(helper.read(&helper.param(0))),
                r#type: Type::Record { shape_id: shape },
                loc: helper.loc(),
            };
            let receiver = self.coerce(narrowed, Type::Dyn, node)?;
            let value = self.dynamic_get(node, receiver, helper.read(&helper.param(1)));
            helper.function.body.push(Stmt::Return {
                value: Some(value),
                loc: helper.loc(),
            });
            return Ok(Expr::Call {
                callee: self.install_helper(helper.function),
                args: vec![
                    obj,
                    Expr::StrLit {
                        value: name.into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                ],
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let (union, tag, shape, field) = self.nullable_field(node, &obj, name)?;
        let mut helper = Helper::new(
            &format!(
                "property_read_r{shape}_{}",
                name.as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
            vec![obj.ty(), Type::String],
            field.r#type.clone(),
            self.loc(node),
        );
        self.property_nullish_guards(&mut helper, false, node)?;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::RecordGet {
                obj: Box::new(Expr::UnionNarrow {
                    union_id: format!("u{union}"),
                    tag,
                    value: Box::new(helper.read(&helper.param(0))),
                    r#type: Type::Record { shape_id: shape },
                    loc: helper.loc(),
                }),
                shape_id: format!("r{shape}"),
                field: field.name,
                r#type: field.r#type.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let value = Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![
                obj,
                Expr::StrLit {
                    value: name.into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                },
            ],
            r#type: field.r#type,
            loc: self.loc(node),
        };
        if self.planned_field_read(node) && !self.directly_truthy_selected_property(node) {
            Ok(value)
        } else {
            self.narrowed(value, node)
        }
    }

    pub(super) fn nullable_record_set(&mut self, node: Node, obj: Expr) -> Result<Stmt, String> {
        let name = node.left().name().text();
        if let Some((_, _, shape)) = self.nullable_record(&obj.ty())
            && !self.records[shape].tuple
            && !self.enum_shape(shape)
            && !self.callables.contains_key(&shape)
            && !self.records[shape]
                .fields
                .iter()
                .any(|field| field.name == name)
        {
            let receiver = self.coerce(obj, Type::Dyn, node.left())?;
            let key = Expr::StrLit {
                value: name.into(),
                r#type: Type::String,
                loc: self.loc(node.left()),
            };
            return self.dynamic_property_set(node, receiver, key);
        }
        let (union, tag, shape, field) = self.nullable_field(node, &obj, name)?;
        let value = self.expected_expression(node.right(), field.r#type.clone())?;
        // Capture the source value before checking the receiver. A dynamic
        // field projection belongs after that check, or its internal ABI
        // error could incorrectly replace the source nullish-property error.
        let value = match value {
            Expr::DynCheck { value, .. } => *value,
            value => value,
        };
        let mut helper = Helper::new(
            &format!(
                "property_write_r{shape}_{}",
                name.as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
            vec![obj.ty(), Type::String, value.ty()],
            Type::Void,
            self.loc(node),
        );
        self.property_nullish_guards(&mut helper, true, node)?;
        helper.function.body.push(Stmt::RecordSet {
            obj: Expr::UnionNarrow {
                union_id: format!("u{union}"),
                tag,
                value: Box::new(helper.read(&helper.param(0))),
                r#type: Type::Record { shape_id: shape },
                loc: helper.loc(),
            },
            shape_id: format!("r{shape}"),
            field: field.name,
            value: self.coerce(helper.read(&helper.param(2)), field.r#type, node.right())?,
            loc: helper.loc(),
        });
        Ok(Stmt::Expression {
            expr: Expr::Call {
                callee: self.install_helper(helper.function),
                args: vec![
                    obj,
                    Expr::StrLit {
                        value: name.into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                    value,
                ],
                r#type: Type::Void,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        })
    }
}
