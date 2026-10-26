//! Object formals use ordinary callee entry slots and owning property stores.
use super::*;

impl Lowerer<'_> {
    pub(super) fn validate_object_parameter(&self, node: Node) -> Result<(), String> {
        let elements = node.name().elements();
        for (index, element) in elements.iter().enumerate() {
            let rest = !element.dot_dot_dot_token().is_nil();
            if element.name().kind() != SyntaxKind::Identifier
                || (rest && (index + 1 != elements.len() || !element.initializer().is_nil()))
                || (!element.property_name().is_nil()
                    && self.data_property_name(element.property_name()).is_none())
            {
                return Err(self.refuse(element, "object parameters require flat named data bindings and a terminal rest binding; nested and computed patterns are not ported"));
            }
        }
        Ok(())
    }

    pub(super) fn bind_object_parameter(
        &mut self,
        node: Node,
        param: &Param,
    ) -> Result<Vec<Stmt>, String> {
        self.validate_object_parameter(node)?;
        let source_type = match &param.r#type {
            Type::Union { union_id } => {
                let arms = self.unions[*union_id]
                    .arms
                    .iter()
                    .filter(|arm| **arm != Type::Undefined)
                    .cloned()
                    .collect::<Vec<_>>();
                if node.initializer().is_nil() || arms.len() != 1 {
                    return Err(self.refuse(
                        node,
                        "object parameter unions require a default and one native data-record arm",
                    ));
                }
                arms[0].clone()
            }
            ty => ty.clone(),
        };
        if let Type::Record { shape_id } = source_type {
            let shape = &self.records[shape_id];
            if shape.tuple
                || shape.index_value.is_some()
                || self.enum_shape(shape_id)
                || self.callables.contains_key(&shape_id)
            {
                return Err(self.refuse(
                    node,
                    "object parameters require a closed native data record",
                ));
            }
        } else if source_type != Type::Dyn {
            return Err(self.refuse(
                node,
                "object parameters require represented data records or owning dynamic values",
            ));
        }
        // The incoming ABI slot has no source binding. Earlier formals are
        // visible to defaults; current/later bindings and body locals are not.
        let mut body = self.bind_parameter(None, param)?;
        let incoming = self.locals.last().unwrap().clone();
        let read = self.construction_read(&incoming, node);
        let value = if node.initializer().is_nil() {
            read
        } else {
            let raw = self.coerce(read.clone(), Type::Dyn, node)?;
            let default = self.expected_expression(node.initializer(), source_type.clone())?;
            let supplied = if let Type::Union { union_id } = param.r#type {
                let tag = self.unions[union_id]
                    .arms
                    .iter()
                    .position(|arm| *arm == source_type)
                    .unwrap();
                Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(read),
                    r#type: source_type.clone(),
                    loc: self.loc(node),
                }
            } else {
                self.coerce(raw.clone(), source_type.clone(), node)?
            };
            Expr::Ternary {
                cond: Box::new(Expr::DynTest {
                    value: Box::new(raw),
                    test: "undefined".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                }),
                then: Box::new(default),
                else_: Box::new(supplied),
                r#type: source_type.clone(),
                loc: self.loc(node),
            }
        };
        let source = self.construction_local(source_type.clone(), false);
        body.push(Stmt::VarDecl {
            local_id: source.id.clone(),
            init: value,
            loc: self.loc(node),
        });
        let raw = self.coerce(self.construction_read(&source, node), Type::Dyn, node)?;
        if source_type == Type::Dyn {
            self.ensure_exception_classes(node)?;
            // ToObject's nullish error precedes property reads and defaults.
            // The retained own-key operation already owns this catchable error.
            body.push(Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(raw.clone()),
                    test: "nullish".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                then: vec![Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: "dyn.objKeys".into(),
                        args: vec![raw.clone()],
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    },
                    loc: self.loc(node),
                }],
                else_: None,
                loc: self.loc(node),
            });
            body.push(Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "dyn.objectRestCheck".into(),
                    args: vec![raw.clone()],
                    r#type: Type::Void,
                    loc: self.loc(node),
                },
                loc: self.loc(node),
            });
        }
        let mut excluded = Vec::new();
        for element in node.name().elements() {
            let rest = !element.dot_dot_dot_token().is_nil();
            let value = if rest {
                let target = if source_type == Type::Dyn {
                    Type::Dyn
                } else {
                    self.storage_type(element.name())?
                };
                self.object_parameter_rest(element, raw.clone(), &excluded, target)?
            } else {
                let key = if element.property_name().is_nil() {
                    element.name().text().to_string()
                } else {
                    self.data_property_name(element.property_name()).unwrap()
                };
                excluded.push(key.clone());
                if let Type::Record { shape_id } = source_type
                    && let Some(field) = self.records[shape_id]
                        .fields
                        .iter()
                        .find(|field| field.name == key)
                {
                    Expr::RecordGet {
                        obj: Box::new(self.construction_read(&source, element)),
                        shape_id: format!("r{shape_id}"),
                        field: key,
                        r#type: field.r#type.clone(),
                        loc: self.loc(element),
                    }
                } else {
                    self.dynamic_get(
                        element,
                        raw.clone(),
                        Expr::StrLit {
                            value: key,
                            r#type: Type::String,
                            loc: self.loc(element),
                        },
                    )
                }
            };
            let formal = Param {
                local_id: format!("v{}", self.locals.len()),
                name: element.name().text().into(),
                r#type: value.ty(),
            };
            body.push(Stmt::VarDecl {
                local_id: formal.local_id.clone(),
                init: value,
                loc: self.loc(element),
            });
            body.extend(self.bind_parameter(Some(element), &formal)?);
            let symbol = self.symbol(element.name());
            if formal.r#type == Type::Dyn {
                self.var_types.insert(symbol, Type::Dyn);
                self.var_defined.remove(&symbol);
            }
        }
        Ok(body)
    }

    fn object_parameter_rest(
        &mut self,
        node: Node,
        source: Expr,
        excluded: &[String],
        target: Type,
    ) -> Result<Expr, String> {
        if target != Type::Dyn
            && !matches!(target, Type::Record { shape_id }
            if !self.records[shape_id].tuple && self.records[shape_id].index_value.is_none()
                && !self.enum_shape(shape_id) && !self.callables.contains_key(&shape_id))
        {
            return Err(self.refuse(
                node,
                "object rest binding requires an owning data-record layout",
            ));
        }
        // Exclusions are semantic input, so they participate in helper identity.
        let identity = format!(
            "object_parameter_rest_{}",
            serde_json::to_string(excluded)
                .unwrap()
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let mut helper =
            helpers::Helper::new(&identity, vec![Type::Dyn], target.clone(), self.loc(node));
        let keys = helper.local("keys", Type::Dyn, false);
        let output = helper.local("own", Type::Dyn, false);
        let index = helper.local("index", Type::F64, true);
        let length = helper.local("length", Type::F64, false);
        let key = helper.local("key", Type::String, true);
        helper.declare(
            &keys,
            Expr::LibCall {
                r#fn: "dyn.objKeys".into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
        );
        helper.declare(
            &output,
            Expr::DynObjLit {
                fields: vec![],
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
        );
        helper.declare(&index, helper.number(0.0));
        helper.declare(
            &key,
            Expr::StrLit {
                value: String::new(),
                r#type: Type::String,
                loc: helper.loc(),
            },
        );
        let count = self.dynamic_get(
            node,
            helper.read(&keys),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: helper.loc(),
            },
        );
        helper.declare(&length, self.coerce(count, Type::F64, node)?);
        let item = self.dynamic_get(
            node,
            helper.read(&keys),
            Expr::ToString {
                operand: Box::new(helper.read(&index)),
                r#type: Type::String,
                loc: helper.loc(),
            },
        );
        let mut iteration = vec![Stmt::Assign {
            local_id: key.id.clone(),
            initializes_global: false,
            value: self.coerce(item, Type::String, node)?,
            loc: helper.loc(),
        }];
        let skip = excluded.iter().fold(
            Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            |previous, name| Expr::Logical {
                op: "||".into(),
                left: Box::new(previous),
                right: Box::new(Expr::StrEq {
                    left: Box::new(helper.read(&key)),
                    right: Box::new(Expr::StrLit {
                        value: name.clone(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
        );
        let value = self.dynamic_get(node, helper.read(&helper.param(0)), helper.read(&key));
        iteration.push(Stmt::If {
            cond: skip,
            then: vec![],
            else_: Some(vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "record.setOwn".into(),
                    args: vec![helper.read(&output), helper.read(&key), value],
                    r#type: Type::Void,
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            }]),
            loc: helper.loc(),
        });
        iteration.push(helper.advance(&index));
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: iteration,
            loc: helper.loc(),
        });
        let result = self.coerce(helper.read(&output), target.clone(), node)?;
        helper.function.body.push(Stmt::Return {
            value: Some(result),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![source],
            r#type: target,
            loc: self.loc(node),
        })
    }
}
