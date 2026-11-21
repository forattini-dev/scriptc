use super::*;

impl Lowerer<'_> {
    fn timer_call_with_arguments(
        &mut self,
        node: Node,
        callee: Node,
        args: &[Node],
    ) -> Result<Expr, String> {
        let loc = self.loc(node);
        let callback_value = self.expression(receivers::reference_node(args[0]))?;
        let callback_value = self.coerce(callback_value, Type::Dyn, args[0])?;
        let delay_value = self.expected_expression(args[1], Type::F64)?;
        let mut statements = Vec::new();
        let callback_local = Local {
            id: format!("timer_callback{}", self.locals.len()),
            name: "timer callback".into(),
            r#type: Type::Dyn,
            mutable: false,
            boxed: true,
        };
        self.locals.push(callback_local.clone());
        statements.push(Stmt::VarDecl {
            local_id: callback_local.id.clone(),
            init: callback_value,
            loc: self.loc(args[0]),
        });
        let delay_local = Local {
            id: format!("timer_delay{}", self.locals.len()),
            name: "timer delay".into(),
            r#type: Type::F64,
            mutable: false,
            boxed: false,
        };
        self.locals.push(delay_local.clone());
        statements.push(Stmt::VarDecl {
            local_id: delay_local.id.clone(),
            init: delay_value,
            loc: self.loc(args[1]),
        });
        let mut argument_locals = Vec::new();
        for argument in &args[2..] {
            let value = self.expression(*argument)?;
            let value = self.coerce(value, Type::Dyn, *argument)?;
            let local = Local {
                id: format!("timer_argument{}", self.locals.len()),
                name: "timer callback argument".into(),
                r#type: Type::Dyn,
                mutable: false,
                boxed: true,
            };
            self.locals.push(local.clone());
            statements.push(Stmt::VarDecl {
                local_id: local.id.clone(),
                init: value,
                loc: self.loc(*argument),
            });
            argument_locals.push(local);
        }
        let adapter_name = format!("timer_argument_adapter_{}", self.next_closure);
        self.next_closure += 1;
        let captured = std::iter::once(&callback_local)
            .chain(argument_locals.iter())
            .enumerate()
            .map(|(index, local)| Param {
                local_id: format!("c{index}"),
                name: local.name.clone(),
                r#type: Type::Dyn,
            })
            .collect::<Vec<_>>();
        let capture_locals = captured
            .iter()
            .map(|capture| Local {
                id: capture.local_id.clone(),
                name: capture.name.clone(),
                r#type: Type::Dyn,
                mutable: false,
                boxed: true,
            })
            .collect::<Vec<_>>();
        let callback_read = Expr::VarRef {
            local_id: captured[0].local_id.clone(),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let call_args = captured[1..]
            .iter()
            .map(|capture| Expr::VarRef {
                local_id: capture.local_id.clone(),
                r#type: Type::Dyn,
                loc: loc.clone(),
            })
            .collect();
        self.lifted.push(Function {
            is_async: false,
            generator: None,
            rest: false,
            name: adapter_name.clone(),
            params: vec![],
            captures: Some(captured),
            return_type: Type::Void,
            locals: capture_locals,
            body: vec![
                Stmt::Expression {
                    expr: Expr::DynCall {
                        callee: Box::new(callback_read),
                        callee_name: "timer callback".into(),
                        args: call_args,
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::Return {
                    value: None,
                    loc: loc.clone(),
                },
            ],
            loc: loc.clone(),
        });
        let callback_type = Type::Func {
            params: vec![],
            ret: Box::new(Type::Void),
            rest: false,
        };
        let captures = std::iter::once(callback_local.id)
            .chain(argument_locals.into_iter().map(|local| local.id))
            .collect();
        let callback = Expr::Closure {
            fn_name: adapter_name,
            captures,
            r#type: callback_type,
            loc: loc.clone(),
        };
        let delay = Expr::VarRef {
            local_id: delay_local.id,
            r#type: Type::F64,
            loc: self.loc(args[1]),
        };
        Ok(Expr::Sequence {
            stmts: statements,
            result: Box::new(Expr::LibCall {
                r#fn: if callee.text() == "setInterval" {
                    "timers.setInterval"
                } else {
                    "timers.setTimeout"
                }
                .into(),
                args: vec![callback, delay],
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            r#type: Type::F64,
            loc,
        })
    }

    pub(super) fn timer_method_symbol(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        self.checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .declarations
            .iter()
            .any(|declaration| {
                !declaration.is_nil()
                    && source_file_info(source_frontend::prelude::get_source_file_of_node(
                        *declaration,
                    ))
                    .file_name
                    .contains("/node_modules/@types/node/")
            })
    }

    pub(super) fn timer_callable_value(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(
                node.name().text().as_ref(),
                "unref" | "ref" | "hasRef" | "refresh"
            )
        {
            return false;
        }
        let receiver = self.checker.get_type_at_location(node.expression());
        self.timer_handle_type(receiver)
    }

    pub(super) fn timer_optional_method_value(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || !node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
            || !matches!(
                node.name().text().as_ref(),
                "unref" | "ref" | "hasRef" | "refresh"
            )
        {
            return false;
        }
        let symbol = self.symbol(node.name());
        self.timer_callable_value(node) || self.timer_method_symbol(symbol)
    }

    pub(super) fn timer_handle_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.name.as_ref() == "Timeout"
            && symbol.declarations.iter().any(|declaration| {
                !declaration.is_nil()
                    && source_file_info(source_frontend::prelude::get_source_file_of_node(
                        *declaration,
                    ))
                    .file_name
                    .contains("/node_modules/@types/node/")
            })
    }

    pub(super) fn timer_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        let timer_method = if callee.kind() == SyntaxKind::PropertyAccessExpression
            && matches!(
                callee.name().text().as_ref(),
                "unref" | "ref" | "hasRef" | "refresh"
            ) {
            let receiver = self.checker.get_type_at_location(callee.expression());
            self.timer_handle_type(receiver)
        } else {
            false
        };
        if timer_method {
            if !node.arguments().is_empty() {
                return Err(
                    self.refuse(node, "native timer handle methods do not accept arguments")
                );
            }
            let handle = self.expected_expression(callee.expression(), Type::F64)?;
            let (r#fn, args, result) = match callee.name().text().as_ref() {
                "unref" => (
                    "timers.setRef",
                    vec![
                        handle,
                        Expr::BoolLit {
                            value: false,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        },
                    ],
                    Type::F64,
                ),
                "ref" => (
                    "timers.setRef",
                    vec![
                        handle,
                        Expr::BoolLit {
                            value: true,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        },
                    ],
                    Type::F64,
                ),
                "hasRef" => ("timers.hasRef", vec![handle], Type::Bool),
                "refresh" => ("timers.refresh", vec![handle], Type::F64),
                _ => unreachable!(),
            };
            return Ok(Some(Expr::LibCall {
                r#fn: r#fn.into(),
                args,
                r#type: result,
                loc: self.loc(node),
            }));
        }
        if callee.kind() != SyntaxKind::Identifier
            || !matches!(
                callee.text().as_ref(),
                "setTimeout"
                    | "setInterval"
                    | "clearTimeout"
                    | "clearInterval"
                    | "setImmediate"
                    | "clearImmediate"
                    | "queueMicrotask"
            )
        {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        if symbol == 0 {
            return Ok(None);
        }
        let symbol = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        let declaration = symbol.value_declaration;
        if symbol.name.as_ref() != callee.text() || declaration.is_nil() || {
            let path = &source_file_info(source_frontend::prelude::get_source_file_of_node(
                declaration,
            ))
            .file_name;
            source_frontend::frontend::bundled::bundled_lib_name(path).is_none()
                && !path.contains("/node_modules/@types/node/")
                && !path.contains("/node_modules/bun-types/")
        } {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if matches!(
            callee.text().as_ref(),
            "clearTimeout" | "clearInterval" | "clearImmediate"
        ) {
            if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(node, "clearTimeout requires one native timer handle"));
            }
            let handle = self.expected_expression(args[0], Type::F64)?;
            return Ok(Some(Expr::LibCall {
                r#fn: if callee.text() == "clearInterval" {
                    "timers.clearInterval"
                } else if callee.text() == "clearImmediate" {
                    "timers.clearImmediate"
                } else {
                    "timers.clearTimeout"
                }
                .into(),
                args: vec![handle],
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        let queue_microtask = callee.text() == "queueMicrotask";
        let immediate = callee.text() == "setImmediate";
        if !queue_microtask
            && !immediate
            && args.len() > 2
            && !args
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return self
                .timer_call_with_arguments(node, callee, &args)
                .map(Some);
        }
        let expected_arguments = if queue_microtask || immediate { 1 } else { 2 };
        if args.len() != expected_arguments
            || args
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                if queue_microtask {
                    "queueMicrotask requires one zero-argument callback"
                } else if immediate {
                    "setImmediate currently requires one zero-argument callback"
                } else {
                    "setTimeout currently requires a zero-argument callback and numeric delay"
                },
            ));
        }
        let callback_type = Type::Func {
            params: vec![],
            ret: Box::new(Type::Void),
            rest: false,
        };
        let callback_node = receivers::reference_node(args[0]);
        let callback = if matches!(
            callback_node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) {
            if !callback_node.parameters().is_empty() {
                return Err(self.refuse(
                    callback_node,
                    "native timer callback must have no parameters",
                ));
            }
            self.closure(callback_node, Some(callback_type.clone()))?
        } else {
            let callback = self.expression(callback_node)?;
            if let Type::Func {
                params,
                ret,
                rest: false,
            } = callback.ty()
                && params.len() == 1
                && *ret == Type::Void
            {
                // Promise resolve callbacks accept an optional value, while
                // timers invoke callbacks with no arguments. JavaScript fills
                // that missing argument with undefined; make the arity bridge
                // explicit in a native closure and retain the captured
                // function's owning identity.
                let source_type = callback.ty();
                let argument = self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(callback_node),
                    },
                    params[0].clone(),
                    callback_node,
                )?;
                let adapter_name = format!("timer_callback_adapter_{}", self.next_closure);
                self.next_closure += 1;
                let capture = Param {
                    local_id: "c0".into(),
                    name: "callback".into(),
                    r#type: source_type.clone(),
                };
                let mut adapter = helpers::Helper::new(
                    &adapter_name,
                    vec![],
                    Type::Void,
                    self.loc(callback_node),
                );
                adapter.function.captures = Some(vec![capture.clone()]);
                adapter.function.locals.push(Local {
                    id: capture.local_id.clone(),
                    name: capture.name.clone(),
                    r#type: capture.r#type.clone(),
                    mutable: false,
                    boxed: true,
                });
                adapter.function.body.push(Stmt::Expression {
                    expr: Expr::CallValue {
                        callee: Box::new(Expr::VarRef {
                            local_id: capture.local_id,
                            r#type: source_type.clone(),
                            loc: self.loc(callback_node),
                        }),
                        args: vec![argument],
                        r#type: Type::Void,
                        loc: self.loc(callback_node),
                    },
                    loc: self.loc(callback_node),
                });
                adapter.function.body.push(Stmt::Return {
                    value: None,
                    loc: self.loc(callback_node),
                });
                self.lifted.push(adapter.function);

                let mut factory = helpers::Helper::new(
                    &format!("{adapter_name}_factory"),
                    vec![source_type],
                    callback_type.clone(),
                    self.loc(callback_node),
                );
                factory.function.locals[0].boxed = true;
                factory.function.body.push(Stmt::Return {
                    value: Some(Expr::Closure {
                        fn_name: adapter_name,
                        captures: vec![factory.param(0).id],
                        r#type: callback_type.clone(),
                        loc: self.loc(callback_node),
                    }),
                    loc: self.loc(callback_node),
                });
                let callee = self.install_helper(factory.function);
                Expr::Call {
                    callee,
                    args: vec![callback],
                    r#type: callback_type.clone(),
                    loc: self.loc(callback_node),
                }
            } else {
                self.coerce(callback, callback_type, callback_node)?
            }
        };
        if queue_microtask {
            return Ok(Some(Expr::LibCall {
                r#fn: "timers.queueMicrotask".into(),
                args: vec![callback],
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        if immediate {
            return Ok(Some(Expr::LibCall {
                r#fn: "timers.setImmediate".into(),
                args: vec![callback],
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        let delay = self.expected_expression(args[1], Type::F64)?;
        Ok(Some(Expr::LibCall {
            r#fn: if callee.text() == "setInterval" {
                "timers.setInterval"
            } else {
                "timers.setTimeout"
            }
            .into(),
            args: vec![callback, delay],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }
}
