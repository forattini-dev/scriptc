//! Array sequence methods use portable iteration and shared sparse storage.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn array_at(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.native_array_method_provenance(member.expression(), symbol, "at") {
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
        let receiver = self.checked_array_receiver(member.expression())?;
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
        let source = receivers::reference_node(member.expression());
        let fluent_native = source.kind() == SyntaxKind::CallExpression;
        let require_standard_symbol =
            !fluent_native && !matches!(self.ty(member.expression()), Ok(Type::Dyn));
        let receiver = self.checked_array_receiver(member.expression())?;
        // A fluent operation produced from an unannotated JS `any` can still
        // lower to an owning Array. A call result that this lowerer has already
        // represented as an Array is likewise an owning fluent result (for
        // example split().map().filter()). In both cases the receiver ABI,
        // rather than a possibly synthetic checker member symbol, proves that
        // this is the native Array operation selected by `array_call`.
        self.array_sequence_method_value(node, receiver, require_standard_symbol)
    }

    pub(super) fn array_sequence_method_value(
        &mut self,
        node: Node,
        receiver: Expr,
        require_standard_symbol: bool,
    ) -> Result<Expr, String> {
        let member = node.expression();
        let name = member.name().text();
        let symbol = self.symbol(member.name());
        let indices_are_defined = matches!(name, "find" | "findIndex")
            && self.array_indices_are_defined(member.expression(), &mut HashSet::new());
        if require_standard_symbol
            && !self.native_array_method_provenance(member.expression(), symbol, name)
        {
            return Err(self.refuse(
                member,
                "array sequence methods require their standard declaration",
            ));
        }
        if !matches!(receiver.ty(), Type::Array { .. }) {
            let checked = self.ty(member.expression()).ok();
            let arms = match receiver.ty() {
                Type::Union { union_id } => Some(self.unions[union_id].arms.clone()),
                _ => None,
            };
            return Err(self.refuse(
                node,
                &format!(
                    "array sequence methods require a non-null native array: receiver {:?}, arms {:?}, checker {:?}",
                    receiver.ty(), arms, checked
                ),
            ));
        }
        let mut values = vec![receiver];
        for (index, argument) in node.arguments().iter().enumerate() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "array sequence argument spreads are not ported"));
            }
            let boolean_symbol = (matches!(name, "filter" | "find" | "findIndex")
                && index == 0
                && argument.kind() == SyntaxKind::Identifier)
                .then(|| self.symbol(argument));
            let boolean_predicate =
                boolean_symbol.is_some_and(|symbol| self.primitive_symbol(symbol, "Boolean", None));
            let value = if boolean_predicate {
                // `filter(Boolean)` and `find(Boolean)` are standard truthy
                // idioms. Represent the global Boolean call as an ordinary
                // callback with the exact operation ABI instead of capturing
                // an ambient constructor binding. Find visits holes, so its
                // first slot must retain the owning dynamic/undefined value.
                let Type::Array { elem } = values[0].ty() else {
                    unreachable!("validated array receiver")
                };
                let first = if name == "filter" {
                    (*elem).clone()
                } else {
                    Type::Dyn
                };
                let params = vec![first, Type::F64, values[0].ty()];
                let mut helper = Helper::new(
                    &format!("boolean_{name}_callback"),
                    params.clone(),
                    Type::Bool,
                    self.loc(argument),
                );
                let first = helper.param(0);
                let value = self.condition(helper.read(&first), argument)?;
                helper.function.body.push(Stmt::Return {
                    value: Some(value),
                    loc: helper.loc(),
                });
                Expr::Closure {
                    fn_name: self.install_helper(helper.function),
                    captures: vec![],
                    r#type: Type::Func {
                        params,
                        ret: Box::new(Type::Bool),
                        rest: false,
                    },
                    loc: self.loc(argument),
                }
            } else if matches!(name, "reduce" | "reduceRight")
                && index == 0
                && matches!(
                    argument.kind(),
                    SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
                )
            {
                let Type::Array { elem } = values[0].ty() else {
                    unreachable!("validated array receiver")
                };
                let arguments = node.arguments();
                let accumulator = if arguments.len() > 1 {
                    self.ty(node).unwrap_or_else(|_| (*elem).clone())
                } else {
                    (*elem).clone()
                };
                self.closure(
                    argument,
                    Some(Type::Func {
                        params: vec![
                            accumulator.clone(),
                            (*elem).clone(),
                            Type::F64,
                            values[0].ty(),
                        ],
                        ret: Box::new(accumulator),
                        rest: false,
                    }),
                )?
            } else if matches!(name, "find" | "findIndex")
                && index == 0
                && argument.kind() == SyntaxKind::ArrowFunction
            {
                // The owning array contract, not an independently materialized
                // contextual checker signature, defines this inline callback.
                // In particular declaration-backed generic results can leave
                // the arrow's contextual type unrepresentable even though the
                // standard Array.find ABI is fully known here. The first slot
                // remains Dyn because find visits holes as undefined.
                self.closure(
                    argument,
                    Some(Type::Func {
                        params: vec![Type::Dyn, Type::F64, values[0].ty()],
                        ret: Box::new(Type::Dyn),
                        rest: false,
                    }),
                )?
            } else {
                self.expression(argument)?
            };
            values.push(self.primitive_capture(value, argument)?);
        }
        if name == "slice" {
            self.array_slice_values(node, values)
        } else if name == "forEach" {
            self.array_for_each_values(node, values)
        } else if name == "filter" {
            self.array_filter_values(node, values)
        } else if matches!(name, "find" | "findIndex") {
            self.array_find_values(node, values, name == "findIndex", indices_are_defined)
        } else if matches!(name, "reduce" | "reduceRight") {
            self.array_reduce_values(node, values, name == "reduceRight")
        } else {
            self.array_predicate_values(node, values, name)
        }
    }

    /// `forEach` snapshots the initial length, skips holes, and observes
    /// mutations of later indices. Its callback result is intentionally
    /// discarded and the standard declaration exposes a void result.
    fn array_for_each_values(&mut self, node: Node, values: Vec<Expr>) -> Result<Expr, String> {
        if !(2..=3).contains(&values.len()) || !matches!(values[1].ty(), Type::Func { .. }) {
            return Err(self.refuse(
                node,
                "array.forEach requires a represented native callback and optional thisArg",
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            "array_for_each",
            values.iter().map(Expr::ty).collect(),
            Type::Void,
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
            callee_name: "Array.forEach callback".into(),
            optional: false,
            args: vec![
                this,
                element,
                self.coerce(helper.read(&index), Type::Dyn, node)?,
                array_value,
            ],
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let done = Stmt::Return {
            value: None,
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
            Stmt::Expression {
                expr: call,
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
            r#type: Type::Void,
            loc: self.loc(node),
        })
    }

    // Snapshot the initial length, but find each next live own index after the
    // callback. This skips holes and observes deletion or filling of later slots.
    fn array_reduce_values(
        &mut self,
        node: Node,
        values: Vec<Expr>,
        reverse: bool,
    ) -> Result<Expr, String> {
        let initial_type = if values.len() >= 3 {
            self.ty(node).unwrap_or_else(|_| values[2].ty())
        } else if let Some(array) = values.first() {
            match array.ty() {
                Type::Array { elem } => *elem,
                _ => Type::Void,
            }
        } else {
            Type::Void
        };
        let supported_accumulator = matches!(
            initial_type,
            Type::F64 | Type::String | Type::Dyn | Type::Array { .. } | Type::Set { .. }
        ) || matches!(initial_type, Type::Record { shape_id }
            if !self.records[shape_id].tuple
                && self.dynamic_erasure_reason(&initial_type).is_none())
            || matches!(initial_type, Type::Union { union_id }
            if self.unions[union_id].arms.iter().all(|arm| matches!(
                arm,
                Type::F64 | Type::String | Type::Bool | Type::Null | Type::Undefined
            )));
        if values.len() < 2 || !supported_accumulator {
            return Err(self.refuse(
                node,
                "array.reduce requires a scalar, collection, plain record or dynamic accumulator",
            ));
        }
        let Type::Func { params, ret, rest } = values[1].ty() else {
            return Err(self.refuse(node, "array.reduce requires a represented native callback"));
        };
        if rest
            || (*ret != initial_type
                && *ret != Type::Dyn
                && initial_type != Type::Dyn
                && !matches!(initial_type, Type::Union { union_id }
                    if self.unions[union_id].arms.contains(&ret)))
            || params.len() > 4
            || params
                .first()
                .is_some_and(|ty| *ty != initial_type && *ty != Type::Dyn)
        {
            return Err(self.refuse(
                node,
                &format!("array.reduce requires a matching accumulator callback: initial={initial_type:?}, params={params:?}, ret={ret:?}"),
            ));
        }
        let accumulator_type = if initial_type == Type::Dyn || *ret == Type::Dyn {
            Type::Dyn
        } else {
            initial_type
        };
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            if reverse {
                "array_reduce_right"
            } else {
                "array_reduce"
            },
            values.iter().map(Expr::ty).collect(),
            accumulator_type.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let length = helper.local("initial length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        let accumulator = helper.local("accumulator", accumulator_type.clone(), true);
        helper.declare(&length, helper.length(&array));
        let first_index = if reverse {
            Expr::Bin {
                op: "-".into(),
                left: Box::new(helper.read(&length)),
                right: Box::new(helper.number(1.0)),
                r#type: Type::F64,
                loc: helper.loc(),
            }
        } else {
            helper.number(0.0)
        };
        helper.declare(&index, first_index);
        let step = |helper: &Helper, index: &Local| Stmt::Assign {
            local_id: index.id.clone(),
            value: Expr::Bin {
                op: if reverse { "-" } else { "+" }.into(),
                left: Box::new(helper.read(index)),
                right: Box::new(helper.number(1.0)),
                r#type: Type::F64,
                loc: helper.loc(),
            },
            initializes_global: false,
            loc: helper.loc(),
        };
        let present_method = if reverse {
            "previousPresent"
        } else {
            "nextPresent"
        };
        if values.len() >= 3 {
            let initial = self.coerce(
                helper.read(&helper.param(2)),
                accumulator_type.clone(),
                node,
            )?;
            helper.declare(&accumulator, initial);
        } else {
            // Without an initial value, the first present element becomes the
            // accumulator and is not passed to the callback.
            helper.function.body.push(Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: present_method.into(),
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
                    op: if reverse { "<" } else { ">=" }.into(),
                    left: Box::new(helper.read(&index)),
                    right: Box::new(if reverse {
                        helper.number(0.0)
                    } else {
                        helper.read(&length)
                    }),
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
            let first = self.coerce(first, accumulator_type.clone(), node)?;
            helper.declare(&accumulator, first);
            helper.function.body.push(step(&helper, &index));
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
            callee_name: if reverse {
                "Array.reduceRight callback"
            } else {
                "Array.reduce callback"
            }
            .into(),
            optional: false,
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
        let call = self.coerce(call, accumulator_type.clone(), node)?;
        let done = Stmt::Return {
            value: Some(helper.read(&accumulator)),
            loc: helper.loc(),
        };
        let body = vec![
            Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: present_method.into(),
                    receiver: Box::new(helper.read(&array)),
                    args: vec![helper.read(&index)],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                initializes_global: false,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: if reverse {
                    Expr::Bin {
                        op: "<".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.number(0.0)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }
                } else {
                    Expr::Logical {
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
                    }
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
            step(&helper, &index),
        ];
        helper.function.body.push(Stmt::While {
            cond: if reverse {
                Expr::Bin {
                    op: ">=".into(),
                    left: Box::new(helper.read(&index)),
                    right: Box::new(helper.number(0.0)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }
            } else {
                helper.less(&index, helper.read(&length))
            },
            body,
            loc: helper.loc(),
        });
        helper.function.body.push(done);
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: accumulator_type,
            loc: self.loc(node),
        })
    }

    /// `find` and `findIndex` snapshot length but visit every index, including
    /// holes. Keep the value read before the callback: it may mutate the array.
    fn array_find_values(
        &mut self,
        node: Node,
        values: Vec<Expr>,
        return_index: bool,
        indices_are_defined: bool,
    ) -> Result<Expr, String> {
        let method = if return_index { "findIndex" } else { "find" };
        if values.len() < 2 || !matches!(values[1].ty(), Type::Func { .. }) {
            return Err(self.refuse(
                node,
                &format!("array.{method} requires a represented native callback"),
            ));
        }
        let Type::Func { params, .. } = values[1].ty() else {
            unreachable!()
        };
        if let Some(first) = params.first()
            && !indices_are_defined
            && *first != Type::Dyn
            && !matches!(first, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
        {
            return Err(self.refuse(
                node,
                &format!("array.{method} callback must represent undefined values from holes"),
            ));
        }
        self.ensure_exception_classes(node)?;
        let result_type = if return_index { Type::F64 } else { Type::Dyn };
        let mut helper = Helper::new(
            &format!("array_{method}"),
            values.iter().map(Expr::ty).collect(),
            result_type.clone(),
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
            callee_name: format!("Array.{method} callback"),
            optional: false,
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
                    value: Some(if return_index {
                        helper.read(&index)
                    } else {
                        helper.read(&element)
                    }),
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
        let missing = if return_index {
            helper.number(-1.0)
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
        helper.function.body.push(Stmt::Return {
            value: Some(missing),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: result_type,
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

    /// `filter` snapshots the source length, skips holes and appends selected
    /// values densely while observing mutations of not-yet-visited indices.
    fn array_filter_values(&mut self, node: Node, values: Vec<Expr>) -> Result<Expr, String> {
        if values.len() < 2 || !matches!(values[1].ty(), Type::Func { .. }) {
            return Err(self.refuse(node, "array.filter requires a represented native callback"));
        }
        let result_type = values[0].ty();
        let Type::Array { elem } = &result_type else {
            unreachable!("array sequence receiver")
        };
        let element_type = (**elem).clone();
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            "array_filter",
            values.iter().map(Expr::ty).collect(),
            result_type.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let length = helper.local("initial length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        let result = helper.local("filtered values", result_type.clone(), false);
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));
        helper.declare(
            &result,
            Expr::ArrayLit {
                elems: vec![],
                r#type: result_type.clone(),
                loc: helper.loc(),
            },
        );
        let array_value = self.coerce(helper.read(&array), Type::Dyn, node)?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let element = self.dynamic_get(node, array_value.clone(), key);
        let element = self.coerce(element, element_type.clone(), node)?;
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
            callee_name: "Array.filter callback".into(),
            optional: false,
            args: vec![
                this,
                self.coerce(element.clone(), Type::Dyn, node)?,
                self.coerce(helper.read(&index), Type::Dyn, node)?,
                array_value,
            ],
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let done = Stmt::Return {
            value: Some(helper.read(&result)),
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
                cond: self.condition(call, node)?,
                then: vec![Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&result)),
                        args: vec![element],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
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
            optional: false,
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
