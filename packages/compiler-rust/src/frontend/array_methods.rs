//! Array sequence methods use portable iteration and shared sparse storage.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn array_at(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, "at", Some("Array"))
            && !self.primitive_symbol(symbol, "at", Some("ReadonlyArray"))
        {
            return Err(self.refuse(member, "array.at requires its standard declaration"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "array.at accepts at most one represented numeric index",
            ));
        }
        let receiver = self.expression(member.expression())?;
        let receiver = self.live_member_receiver(member.expression(), receiver);
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(member, "array.at requires a non-null native array"));
        };
        let index = if let Some(argument) = arguments.first() {
            self.expected_expression(*argument, Type::F64)?
        } else {
            Expr::NumLit {
                value: 0.0,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            }
        };
        let result = self.undefined_storage_type(*elem, node)?;
        let mut helper = Helper::new(
            "array_at",
            vec![receiver.ty(), Type::F64],
            result.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let input = helper.param(1);
        let length = helper.local("length", Type::F64, false);
        let integer = helper.local("integer index", Type::F64, false);
        let position = helper.local("relative index", Type::F64, false);
        helper.declare(&length, helper.length(&array));
        let nan = Expr::Bin {
            op: "!==".into(),
            left: Box::new(helper.read(&input)),
            right: Box::new(helper.read(&input)),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let trunc = Expr::LibCall {
            r#fn: "math.trunc".into(),
            args: vec![helper.read(&input)],
            r#type: Type::F64,
            loc: helper.loc(),
        };
        helper.declare(
            &integer,
            Expr::Ternary {
                cond: Box::new(nan),
                then: Box::new(helper.number(0.0)),
                else_: Box::new(trunc),
                r#type: Type::F64,
                loc: helper.loc(),
            },
        );
        let negative = Expr::Bin {
            op: "<".into(),
            left: Box::new(helper.read(&integer)),
            right: Box::new(helper.number(0.0)),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let relative = Expr::Bin {
            op: "+".into(),
            left: Box::new(helper.read(&length)),
            right: Box::new(helper.read(&integer)),
            r#type: Type::F64,
            loc: helper.loc(),
        };
        helper.declare(
            &position,
            Expr::Ternary {
                cond: Box::new(negative),
                then: Box::new(relative),
                else_: Box::new(helper.read(&integer)),
                r#type: Type::F64,
                loc: helper.loc(),
            },
        );
        let below = Expr::Bin {
            op: "<".into(),
            left: Box::new(helper.read(&position)),
            right: Box::new(helper.number(0.0)),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let above = Expr::Bin {
            op: ">=".into(),
            left: Box::new(helper.read(&position)),
            right: Box::new(helper.read(&length)),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let missing = self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: helper.loc(),
            },
            result.clone(),
            node,
        )?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&position)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let value = self.coerce(helper.read(&array), Type::Dyn, node)?;
        let value = self.dynamic_get(node, value, key);
        let value = self.coerce(value, result.clone(), node)?;
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::Ternary {
                cond: Box::new(Expr::Logical {
                    op: "||".into(),
                    left: Box::new(below),
                    right: Box::new(above),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                then: Box::new(missing),
                else_: Box::new(value),
                r#type: result.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![receiver, index],
            r#type: result,
            loc: self.loc(node),
        })
    }

    pub(super) fn array_sequence_method(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let name = member.name().text();
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, name, Some("Array"))
            && !self.primitive_symbol(symbol, name, Some("ReadonlyArray"))
        {
            return Err(self.refuse(
                member,
                "array sequence methods require their standard declaration",
            ));
        }
        let receiver = self.expression(member.expression())?;
        let receiver = self.live_member_receiver(member.expression(), receiver);
        if !matches!(receiver.ty(), Type::Array { .. }) {
            return Err(self.refuse(
                node,
                "array sequence methods require a non-null native array",
            ));
        }
        let mut values = vec![receiver];
        for (index, argument) in node.arguments().iter().enumerate() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "array sequence argument spreads are not ported"));
            }
            let value =
                if name == "find" && index == 0 && argument.kind() == SyntaxKind::ArrowFunction {
                    let ty = self.ty(argument)?;
                    if let Type::Func {
                        mut params,
                        ret,
                        rest,
                    } = ty
                    {
                        if !params.is_empty() && !rest {
                            // Inline callbacks are created solely for this call. Give
                            // their first formal the actual JS value domain, so an
                            // array hole reaches the callback as undefined.
                            params[0] = Type::Dyn;
                        }
                        self.closure(argument, Some(Type::Func { params, ret, rest }))?
                    } else {
                        self.expression(argument)?
                    }
                } else {
                    self.expression(argument)?
                };
            values.push(self.primitive_capture(value, argument)?);
        }
        if name == "slice" {
            self.array_slice_values(node, values)
        } else if name == "find" {
            self.array_find_values(node, values)
        } else if name == "reduce" {
            self.array_reduce_values(node, values)
        } else {
            self.array_predicate_values(node, values, name)
        }
    }

    // Snapshot the initial length, but find each next live own index after the
    // callback. This skips holes and observes deletion or filling of later slots.
    fn array_reduce_values(&mut self, node: Node, values: Vec<Expr>) -> Result<Expr, String> {
        if values.len() < 2
            || (values.len() >= 3 && values[2].ty() != Type::F64)
            || (values.len() == 2
                && !matches!(values[0].ty(), Type::Array { elem } if *elem == Type::F64))
        {
            return Err(self.refuse(
                node,
                "array.reduce requires a numeric initial value or numeric array",
            ));
        }
        let Type::Func { params, ret, rest } = values[1].ty() else {
            return Err(self.refuse(node, "array.reduce requires a represented native callback"));
        };
        if rest
            || *ret != Type::F64
            || params.len() > 4
            || params.first().is_some_and(|ty| *ty != Type::F64)
        {
            return Err(self.refuse(node, "array.reduce requires a numeric accumulator callback"));
        }
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            "array_reduce",
            values.iter().map(Expr::ty).collect(),
            Type::F64,
            self.loc(node),
        );
        let array = helper.param(0);
        let length = helper.local("initial length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        let accumulator = helper.local("accumulator", Type::F64, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));
        if values.len() >= 3 {
            helper.declare(&accumulator, helper.read(&helper.param(2)));
        } else {
            // Without an initial value, the first present element becomes the
            // accumulator and is not passed to the callback.
            helper.function.body.push(Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: "nextPresent".into(),
                    receiver: Box::new(helper.read(&array)),
                    args: vec![helper.read(&index)],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                initializes_global: false,
                loc: helper.loc(),
            });
            helper.function.body.push(Stmt::If {
                cond: Expr::Bin {
                    op: ">=".into(),
                    left: Box::new(helper.read(&index)),
                    right: Box::new(helper.read(&length)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Throw {
                    value: Expr::LibCall {
                        r#fn: "error.new".into(),
                        args: vec![Expr::StrLit {
                            value: "Reduce of empty array with no initial value".into(),
                            r#type: Type::String,
                            loc: helper.loc(),
                        }],
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
            let first_key = Expr::ToString {
                operand: Box::new(helper.read(&index)),
                r#type: Type::String,
                loc: helper.loc(),
            };
            let source = self.coerce(helper.read(&array), Type::Dyn, node)?;
            let first = self.dynamic_get(node, source, first_key);
            let first = self.coerce(first, Type::F64, node)?;
            helper.declare(&accumulator, first);
            helper.function.body.push(helper.advance(&index));
        }
        let array_value = self.coerce(helper.read(&array), Type::Dyn, node)?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let element = self.dynamic_get(node, array_value.clone(), key);
        let this = self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: helper.loc(),
            },
            Type::Dyn,
            node,
        )?;
        let call = Expr::DynInvoke {
            recv: Box::new(self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?),
            method: "call".into(),
            callee_name: "Array.reduce callback".into(),
            args: vec![
                this,
                self.coerce(helper.read(&accumulator), Type::Dyn, node)?,
                element,
                self.coerce(helper.read(&index), Type::Dyn, node)?,
                array_value,
            ],
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let call = self.coerce(call, Type::F64, node)?;
        let done = Stmt::Return {
            value: Some(helper.read(&accumulator)),
            loc: helper.loc(),
        };
        let body = vec![
            Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: "nextPresent".into(),
                    receiver: Box::new(helper.read(&array)),
                    args: vec![helper.read(&index)],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                initializes_global: false,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: Expr::Logical {
                    op: "||".into(),
                    left: Box::new(Expr::Bin {
                        op: ">=".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.read(&length)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    right: Box::new(Expr::Bin {
                        op: ">=".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.length(&array)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![done.clone()],
                else_: None,
                loc: helper.loc(),
            },
            Stmt::Assign {
                local_id: accumulator.id.clone(),
                value: call,
                initializes_global: false,
                loc: helper.loc(),
            },
            helper.advance(&index),
        ];
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body,
            loc: helper.loc(),
        });
        helper.function.body.push(done);
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    /// `find` snapshots length but visits every index, including holes. Keep
    /// the value read before the callback: the callback may mutate the array.
    fn array_find_values(&mut self, node: Node, values: Vec<Expr>) -> Result<Expr, String> {
        if values.len() < 2 || !matches!(values[1].ty(), Type::Func { .. }) {
            return Err(self.refuse(node, "array.find requires a represented native callback"));
        }
        let Type::Func { params, .. } = values[1].ty() else {
            unreachable!()
        };
        if let Some(first) = params.first()
            && *first != Type::Dyn
            && !matches!(first, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
        {
            return Err(self.refuse(
                node,
                "array.find callback must represent undefined values from holes",
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            "array_find",
            values.iter().map(Expr::ty).collect(),
            Type::Dyn,
            self.loc(node),
        );
        let array = helper.param(0);
        let length = helper.local("initial length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        let element = helper.local("visited value", Type::Dyn, false);
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));
        let array_value = self.coerce(helper.read(&array), Type::Dyn, node)?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let value = self.dynamic_get(node, array_value.clone(), key);
        let this = if values.len() > 2 {
            self.coerce(helper.read(&helper.param(2)), Type::Dyn, node)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: helper.loc(),
                },
                Type::Dyn,
                node,
            )?
        };
        let call = Expr::DynInvoke {
            recv: Box::new(self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?),
            method: "call".into(),
            callee_name: "Array.find callback".into(),
            args: vec![
                this,
                helper.read(&element),
                self.coerce(helper.read(&index), Type::Dyn, node)?,
                array_value,
            ],
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let body = vec![
            Stmt::VarDecl {
                local_id: element.id.clone(),
                init: value,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: self.condition(call, node)?,
                then: vec![Stmt::Return {
                    value: Some(helper.read(&element)),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            },
            helper.advance(&index),
        ];
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body,
            loc: helper.loc(),
        });
        let undefined = self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: helper.loc(),
            },
            Type::Dyn,
            node,
        )?;
        helper.function.body.push(Stmt::Return {
            value: Some(undefined),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }

    fn array_slice_values(&mut self, node: Node, values: Vec<Expr>) -> Result<Expr, String> {
        let result_type = values[0].ty();
        let mut helper = Helper::new(
            "array_slice",
            values.iter().map(Expr::ty).collect(),
            result_type.clone(),
            self.loc(node),
        );
        let mut args = Vec::new();
        for (index, default) in [(1, 0.0), (2, f64::INFINITY)] {
            let value = (index < values.len()).then(|| helper.read(&helper.param(index)));
            args.push(self.primitive_string_argument(
                value,
                crate::string_builtins::Argument::Number(default),
                node,
            )?);
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::ArrayIntrinsic {
                method: "slice".into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args,
                r#type: result_type.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn array_predicate_values(
        &mut self,
        node: Node,
        values: Vec<Expr>,
        method: &str,
    ) -> Result<Expr, String> {
        if values.len() < 2 || !matches!(values[1].ty(), Type::Func { .. }) {
            return Err(self.refuse(
                node,
                &format!("array.{method} requires a represented native callback"),
            ));
        }
        let every = method == "every";
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            &format!("array_{method}"),
            values.iter().map(Expr::ty).collect(),
            Type::Bool,
            self.loc(node),
        );
        let array = helper.param(0);
        let length = helper.local("initial length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));
        let array_value = self.coerce(helper.read(&array), Type::Dyn, node)?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let element = self.dynamic_get(node, array_value.clone(), key);
        let this = if values.len() > 2 {
            self.coerce(helper.read(&helper.param(2)), Type::Dyn, node)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: helper.loc(),
                },
                Type::Dyn,
                node,
            )?
        };
        let call = Expr::DynInvoke {
            recv: Box::new(self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?),
            method: "call".into(),
            callee_name: format!("Array.{method} callback"),
            args: vec![
                this,
                element,
                self.coerce(helper.read(&index), Type::Dyn, node)?,
                array_value,
            ],
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let boolean = |value| Expr::BoolLit {
            value,
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let done = Stmt::Return {
            value: Some(boolean(every)),
            loc: helper.loc(),
        };
        let body = vec![
            Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: "nextPresent".into(),
                    receiver: Box::new(helper.read(&array)),
                    args: vec![helper.read(&index)],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                initializes_global: false,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: Expr::Logical {
                    op: "||".into(),
                    left: Box::new(Expr::Bin {
                        op: ">=".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.read(&length)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    right: Box::new(Expr::Bin {
                        op: ">=".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.length(&array)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![done.clone()],
                else_: None,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: Expr::Bin {
                    op: "===".into(),
                    left: Box::new(self.condition(call, node)?),
                    right: Box::new(boolean(!every)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(boolean(!every)),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            },
            helper.advance(&index),
        ];
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body,
            loc: helper.loc(),
        });
        helper.function.body.push(done);
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }
}
