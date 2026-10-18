//! A private construction plan snapshots values before publishing a typed record.
use super::*;

struct Slot {
    name: String,
    ty: Type,
    value: Local,
    present: Local,
}
struct Plan {
    slots: Vec<Slot>,
    keys: Local,
}

impl Lowerer<'_> {
    fn construction_local(&mut self, ty: Type, mutable: bool) -> Local {
        let local = Local {
            id: format!("construct{}", self.locals.len()),
            name: "record construction".into(),
            r#type: ty,
            mutable,
            boxed: false,
        };
        self.locals.push(local.clone());
        local
    }
    fn construction_read(&self, local: &Local, node: Node) -> Expr {
        Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        }
    }
    fn construction_undefined(&self, node: Node) -> Expr {
        Expr::UnitLit {
            unit: "undefined",
            r#type: Type::Undefined,
            loc: self.loc(node),
        }
    }
    fn construction_optional(&self, ty: &Type) -> bool {
        matches!(ty, Type::Undefined)
            || matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
    }
    pub(super) fn construct_record(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            unreachable!()
        };
        let record = self.records[shape_id].clone();
        if record.tuple
            || record.index_value.is_some()
            || self.callables.contains_key(&shape_id)
            || self.enum_shape(shape_id)
            || ir::contains_set(&target, &self.records, &self.unions)
        {
            return Err(self.refuse(
                node,
                "record construction needs a closed native data layout",
            ));
        }
        let keys = self.construction_local(
            Type::Array {
                elem: Box::new(Type::String),
            },
            false,
        );
        let mut stmts = vec![Stmt::VarDecl {
            local_id: keys.id.clone(),
            init: Expr::ArrayLit {
                elems: vec![],
                r#type: keys.r#type.clone(),
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        let mut slots = Vec::new();
        for field in record.fields {
            let value = self.construction_local(Type::Dyn, true);
            let present = self.construction_local(Type::Bool, true);
            stmts.push(Stmt::VarDecl {
                local_id: value.id.clone(),
                init: self.coerce(self.construction_undefined(node), Type::Dyn, node)?,
                loc: self.loc(node),
            });
            stmts.push(Stmt::VarDecl {
                local_id: present.id.clone(),
                init: Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                loc: self.loc(node),
            });
            slots.push(Slot {
                name: field.name,
                ty: field.r#type,
                value,
                present,
            });
        }
        let plan = Plan { slots, keys };
        let mut definite = HashSet::new();
        for property in properties {
            let (body, written) = self.construction_property(property, &plan)?;
            stmts.extend(body);
            definite.extend(written);
        }
        for slot in &plan.slots {
            if !self.construction_optional(&slot.ty) && !definite.contains(&slot.name) {
                return Err(self.refuse(
                    node,
                    "record construction cannot prove a required own field on every path",
                ));
            }
        }
        let fields = plan
            .slots
            .iter()
            .map(|slot| {
                Ok(ir::FieldInit {
                    name: slot.name.clone(),
                    value: self.coerce(
                        self.construction_read(&slot.value, node),
                        slot.ty.clone(),
                        node,
                    )?,
                    absent: false,
                    overflow: false,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: "record.cloneOwn".into(),
                args: vec![
                    Expr::RecordLit {
                        fields,
                        r#type: target.clone(),
                        loc: self.loc(node),
                    },
                    self.construction_read(&plan.keys, node),
                ],
                r#type: target.clone(),
                loc: self.loc(node),
            }),
            r#type: target,
            loc: self.loc(node),
        })
    }
    fn construction_write(
        &self,
        node: Node,
        plan: &Plan,
        slot: &Slot,
        value: Expr,
    ) -> Result<Vec<Stmt>, String> {
        let value = self.coerce(value, slot.ty.clone(), node)?;
        Ok(vec![
            Stmt::Assign {
                local_id: slot.value.id.clone(),
                value: self.coerce(value, Type::Dyn, node)?,
                initializes_global: false,
                loc: self.loc(node),
            },
            Stmt::If {
                cond: Expr::Unary {
                    op: "!".into(),
                    operand: Box::new(self.construction_read(&slot.present, node)),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                then: vec![
                    Stmt::Expression {
                        expr: Expr::ArrayIntrinsic {
                            method: "push".into(),
                            receiver: Box::new(self.construction_read(&plan.keys, node)),
                            args: vec![Expr::StrLit {
                                value: slot.name.clone(),
                                r#type: Type::String,
                                loc: self.loc(node),
                            }],
                            r#type: Type::F64,
                            loc: self.loc(node),
                        },
                        loc: self.loc(node),
                    },
                    Stmt::Assign {
                        local_id: slot.present.id.clone(),
                        value: Expr::BoolLit {
                            value: true,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        },
                        initializes_global: false,
                        loc: self.loc(node),
                    },
                ],
                else_: None,
                loc: self.loc(node),
            },
        ])
    }
    fn construction_property(
        &mut self,
        property: Node,
        plan: &Plan,
    ) -> Result<(Vec<Stmt>, HashSet<String>), String> {
        if property.kind() == SyntaxKind::SpreadAssignment {
            return self.construction_source(property.expression(), plan);
        }
        if !matches!(
            property.kind(),
            SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
        ) {
            return Err(self.refuse(
                property,
                "record construction requires named data properties",
            ));
        }
        let name = self
            .data_property_name(property.name())
            .ok_or_else(|| self.refuse(property, "computed construction keys are not ported"))?;
        if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
            return Err(self.refuse(property, "object prototype setters are not ported"));
        }
        let slot = plan.slots.iter().find(|s| s.name == name).ok_or_else(|| {
            self.refuse(
                property,
                "record construction width projection is not ported",
            )
        })?;
        let source = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
            property.name()
        } else {
            property.initializer()
        };
        let value = self.expected_expression(source, slot.ty.clone())?;
        Ok((
            self.construction_write(property, plan, slot, value)?,
            HashSet::from([name]),
        ))
    }
    fn construction_source(
        &mut self,
        source: Node,
        plan: &Plan,
    ) -> Result<(Vec<Stmt>, HashSet<String>), String> {
        match source.kind() {
            SyntaxKind::ParenthesizedExpression => {
                self.construction_source(source.expression(), plan)
            }
            SyntaxKind::ObjectLiteralExpression => {
                let mut body = Vec::new();
                let mut definite = HashSet::new();
                for property in source.properties() {
                    let (next, written) = self.construction_property(property, plan)?;
                    body.extend(next);
                    definite.extend(written);
                }
                Ok((body, definite))
            }
            SyntaxKind::ConditionalExpression => {
                let value = self.condition_value(source.condition())?;
                let cond = self.condition(value, source.condition())?;
                let before = self.var_defined.clone();
                if let Some(symbol) = self.guarded_var(source.condition(), true) {
                    self.var_defined.insert(symbol);
                }
                let (then, yes) = self.construction_source(source.when_true(), plan)?;
                let then_defined = self.var_defined.clone();
                self.var_defined = before;
                if let Some(symbol) = self.guarded_var(source.condition(), false) {
                    self.var_defined.insert(symbol);
                }
                let (other, no) = self.construction_source(source.when_false(), plan)?;
                self.var_defined = then_defined
                    .intersection(&self.var_defined)
                    .copied()
                    .collect();
                Ok((
                    vec![Stmt::If {
                        cond,
                        then,
                        else_: Some(other),
                        loc: self.loc(source),
                    }],
                    yes.intersection(&no).cloned().collect(),
                ))
            }
            _ => self.construction_copy(source, plan),
        }
    }
    fn construction_copy(
        &mut self,
        source: Node,
        plan: &Plan,
    ) -> Result<(Vec<Stmt>, HashSet<String>), String> {
        let value = self.expression(source)?;
        let Type::Record { shape_id } = value.ty() else {
            return Err(self.refuse(source, "spread source needs one closed native data record"));
        };
        let record = self.records[shape_id].clone();
        if record.tuple
            || record.index_value.is_some()
            || self.callables.contains_key(&shape_id)
            || self.enum_shape(shape_id)
        {
            return Err(self.refuse(
                source,
                "spread source needs a closed data record without receiver semantics",
            ));
        }
        let object = self.construction_local(value.ty(), false);
        let keys = self.construction_local(Type::Dyn, false);
        let index = self.construction_local(Type::F64, true);
        let key = self.construction_local(Type::String, true);
        let mut body = vec![
            Stmt::VarDecl {
                local_id: object.id.clone(),
                init: value,
                loc: self.loc(source),
            },
            Stmt::VarDecl {
                local_id: keys.id.clone(),
                init: Expr::LibCall {
                    r#fn: "dyn.objKeys".into(),
                    args: vec![self.coerce(
                        self.construction_read(&object, source),
                        Type::Dyn,
                        source,
                    )?],
                    r#type: Type::Dyn,
                    loc: self.loc(source),
                },
                loc: self.loc(source),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: Expr::NumLit {
                    value: 0.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(source),
                },
                loc: self.loc(source),
            },
            Stmt::VarDecl {
                local_id: key.id.clone(),
                init: Expr::StrLit {
                    value: String::new(),
                    r#type: Type::String,
                    loc: self.loc(source),
                },
                loc: self.loc(source),
            },
        ];
        let key_value = self.dynamic_get(
            source,
            self.construction_read(&keys, source),
            Expr::ToString {
                operand: Box::new(self.construction_read(&index, source)),
                r#type: Type::String,
                loc: self.loc(source),
            },
        );
        let mut iteration = vec![Stmt::Assign {
            local_id: key.id.clone(),
            value: self.coerce(key_value, Type::String, source)?,
            initializes_global: false,
            loc: self.loc(source),
        }];
        let mut definite = HashSet::new();
        for field in record.fields {
            let slot = plan
                .slots
                .iter()
                .find(|s| s.name == field.name)
                .ok_or_else(|| {
                    self.refuse(source, "spread source has keys outside its target layout")
                })?;
            let value = Expr::RecordGet {
                obj: Box::new(self.construction_read(&object, source)),
                shape_id: format!("r{shape_id}"),
                field: field.name.clone(),
                r#type: field.r#type.clone(),
                loc: self.loc(source),
            };
            let writes = self.construction_write(source, plan, slot, value)?;
            let cond = Expr::StrEq {
                left: Box::new(self.construction_read(&key, source)),
                right: Box::new(Expr::StrLit {
                    value: field.name.clone(),
                    r#type: Type::String,
                    loc: self.loc(source),
                }),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(source),
            };
            iteration.push(Stmt::If {
                cond,
                then: writes,
                else_: None,
                loc: self.loc(source),
            });
            if !self.construction_optional(&field.r#type) {
                definite.insert(field.name);
            }
        }
        iteration.push(Stmt::Assign {
            local_id: index.id.clone(),
            value: Expr::Bin {
                op: "+".into(),
                left: Box::new(self.construction_read(&index, source)),
                right: Box::new(Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(source),
                }),
                r#type: Type::F64,
                loc: self.loc(source),
            },
            initializes_global: false,
            loc: self.loc(source),
        });
        let length = self.dynamic_get(
            source,
            self.construction_read(&keys, source),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: self.loc(source),
            },
        );
        body.push(Stmt::While {
            cond: Expr::Bin {
                op: "<".into(),
                left: Box::new(self.construction_read(&index, source)),
                right: Box::new(self.coerce(length, Type::F64, source)?),
                r#type: Type::Bool,
                loc: self.loc(source),
            },
            body: iteration,
            loc: self.loc(source),
        });
        Ok((body, definite))
    }
}
