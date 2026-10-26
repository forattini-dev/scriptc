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
            let message = self.string_concat(
                self.string_concat(
                    string(format!(
                        "Cannot {} properties of {unit} ({} '",
                        if setting { "set" } else { "read" },
                        if setting { "setting" } else { "reading" }
                    )),
                    helper.read(&key),
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
        let mut helper = Helper::new(
            "property_write",
            vec![Type::Dyn, Type::String, Type::Dyn],
            Type::Void,
            self.loc(node),
        );
        self.property_nullish_guards(&mut helper, true, node)?;
        helper.function.body.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.keySet".into(),
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
        if record.tuple
            || self.enum_shape(shape)
            || self.callables.contains_key(&shape)
            || record.index_value.is_some()
        {
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
        if self.planned_field_read(node) {
            Ok(value)
        } else {
            self.narrowed(value, node)
        }
    }

    pub(super) fn nullable_record_set(&mut self, node: Node, obj: Expr) -> Result<Stmt, String> {
        let name = node.left().name().text();
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
