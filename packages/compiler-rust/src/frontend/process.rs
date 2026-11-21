//! Live process property reads are recognized by declaration/import identity.
use super::*;

impl Lowerer<'_> {
    pub(super) fn events_once_drain(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 2
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            || (!self.process_member(arguments[0], "stdout")
                && !self.process_member(arguments[0], "stderr"))
            || arguments[1].kind() != SyntaxKind::StringLiteral
            || arguments[1].text() != "drain"
        {
            return Err(self.refuse(
                node,
                "events.once currently supports only process.stdout/process.stderr and the literal drain event",
            ));
        }
        // Native process writes are synchronous and always report acceptance,
        // so a well-formed backpressure guard cannot reach this call. Keep the
        // expression representable as an already-settled Promise while still
        // evaluating the emitter argument exactly once.
        let emitter = self.expression(arguments[0])?;
        let payload_type = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let promise_type = Type::Promise {
            inner: Box::new(payload_type.clone()),
        };
        Ok(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: emitter,
                loc: self.loc(arguments[0]),
            }],
            result: Box::new(Expr::Intrinsic {
                name: "promise.resolve".into(),
                args: vec![Expr::ArrayLit {
                    elems: vec![],
                    r#type: payload_type,
                    loc: self.loc(node),
                }],
                r#type: promise_type.clone(),
                loc: self.loc(node),
            }),
            r#type: promise_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn process_exit_code_assignment(
        &mut self,
        node: Node,
    ) -> Result<Option<Stmt>, String> {
        let left = node.left();
        if left.kind() != SyntaxKind::PropertyAccessExpression
            || left.name().text() != "exitCode"
            || self.native_namespace(left.expression()) != Some("process")
        {
            return Ok(None);
        }
        let value = if node.right().kind() == SyntaxKind::AwaitExpression {
            if self.return_type.is_none() {
                let promise = self.expected_expression(
                    node.right().expression(),
                    Type::Promise {
                        inner: Box::new(Type::F64),
                    },
                )?;
                Expr::Intrinsic {
                    name: "promise.block".into(),
                    args: vec![promise],
                    r#type: Type::F64,
                    loc: self.loc(node.right()),
                }
            } else {
                self.terminal_await(node.right(), &Type::F64)?
            }
        } else {
            self.expected_expression(node.right(), Type::F64)?
        };
        Ok(Some(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "process.exitCodeSet".into(),
                args: vec![value],
                r#type: Type::Void,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn process_stdin_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !self.process_member(member.expression(), "stdin")
            || !matches!(
                member.name().text(),
                "on" | "removeListener" | "setRawMode" | "resume" | "pause" | "isPaused"
            )
        {
            return Ok(None);
        }
        let recv = self
            .process_read(member.expression())?
            .expect("recognized process.stdin value");
        let args = node
            .arguments()
            .into_iter()
            .map(|argument| self.expected_expression(argument, Type::Dyn))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Expr::DynInvoke {
            recv: Box::new(recv),
            method: member.name().text().into(),
            callee_name: format!("process.stdin.{}", member.name().text()),
            optional: false,
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn process_exception_listener(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(
                member.name().text(),
                "on" | "once" | "off" | "removeListener"
            )
            || self.native_namespace(member.expression()) != Some("process")
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let event = args
            .first()
            .filter(|event| event.kind() == SyntaxKind::StringLiteral)
            .map(|event| event.text());
        let member_name = member.name().text();
        let removing = matches!(member_name, "off" | "removeListener");
        let signal = match event {
            Some("SIGINT") => Some(2.0),
            Some("SIGTERM") => Some(15.0),
            Some("SIGWINCH") => Some(28.0),
            _ => None,
        };
        if let Some(signal) = signal {
            if node.parent().kind() != SyntaxKind::ExpressionStatement || args.len() != 2 {
                return Err(self.refuse(
                    node,
                    "process signal listeners require a discarded registration with two arguments",
                ));
            }
            let signature = Type::Func {
                rest: false,
                params: vec![],
                ret: Box::new(Type::Void),
            };
            let callback = self.expected_expression(args[1], signature)?;
            let mut lowered = vec![
                Expr::NumLit {
                    value: signal,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(args[0]),
                },
                callback,
            ];
            let operation = if removing {
                "process.offSignal"
            } else {
                lowered.push(Expr::BoolLit {
                    value: member_name == "once",
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
                "process.onSignal"
            };
            return Ok(Some(Expr::LibCall {
                r#fn: operation.into(),
                args: lowered,
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        let lifecycle = match event {
            Some("exit") => Some(if removing {
                "process.offExit"
            } else {
                "process.onExit"
            }),
            Some("uncaughtExceptionMonitor") => Some(if removing {
                "process.offUncaughtMonitor"
            } else {
                "process.onUncaughtMonitor"
            }),
            _ => None,
        };
        if let Some(operation) = lifecycle {
            if node.parent().kind() != SyntaxKind::ExpressionStatement || args.len() != 2 {
                return Err(self.refuse(
                    node,
                    "process lifecycle listeners require a discarded registration with two arguments",
                ));
            }
            let callback = self.expression(args[1])?;
            if !matches!(callback.ty(), Type::Func { .. } | Type::Dyn) {
                return Err(self.refuse(args[1], "process lifecycle listener must be callable"));
            }
            let callback = self.coerce(callback, Type::Dyn, args[1])?;
            return Ok(Some(Expr::LibCall {
                r#fn: operation.into(),
                args: vec![callback],
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        if event.is_none() && args.len() == 2 {
            if node.parent().kind() != SyntaxKind::ExpressionStatement {
                return Err(self.refuse(
                    node,
                    "process signal listeners require a discarded registration",
                ));
            }
            let signature = Type::Func {
                rest: false,
                params: vec![],
                ret: Box::new(Type::Void),
            };
            let signal = self.expected_expression(args[0], Type::String)?;
            let callback = self.expected_expression(args[1], signature)?;
            let mut lowered = vec![signal, callback];
            let operation = if removing {
                "process.offNamedSignal"
            } else {
                lowered.push(Expr::BoolLit {
                    value: member_name == "once",
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
                "process.onNamedSignal"
            };
            return Ok(Some(Expr::LibCall {
                r#fn: operation.into(),
                args: lowered,
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        if member_name != "on" {
            return Ok(None);
        }
        let operation = match event {
            Some("unhandledRejection") => "process.onUnhandledRejection",
            Some("uncaughtException") => "process.onUncaughtException",
            _ => return Ok(None),
        };
        if node.parent().kind() != SyntaxKind::ExpressionStatement
            || args.len() != 2
            || args[1].kind() != SyntaxKind::ArrowFunction
            || args[1].parameters().into_iter().count() != 1
        {
            return Err(self.refuse(node, "process exception listeners require a discarded registration with a one-parameter arrow"));
        }
        self.ensure_exception_classes(node)?;
        let signature = Type::Func {
            rest: false,
            params: vec![Type::Dyn],
            ret: Box::new(Type::Void),
        };
        let callback = self.closure(args[1], Some(signature))?;
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args: vec![
                self.coerce(callback, Type::Dyn, node)?,
                Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            ],
            r#type: Type::Void,
            loc: self.loc(node),
        }))
    }
    pub(super) fn process_env_assignment(&mut self, node: Node) -> Result<Option<Stmt>, String> {
        let member = node.left();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !self.process_member(member.expression(), "env")
        {
            return Ok(None);
        }
        let key = member.name().text().to_string();
        let value = self.expected_expression(node.right(), Type::String)?;
        let loc = self.loc(node);
        Ok(Some(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "process.envSet".into(),
                args: vec![
                    Expr::StrLit {
                        value: key,
                        r#type: Type::String,
                        loc: self.loc(member),
                    },
                    value,
                ],
                r#type: Type::Void,
                loc: loc.clone(),
            },
            loc,
        }))
    }
    pub(super) fn node_stream_owning_type(&self, id: TypeId) -> bool {
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::INTERSECTION)
        {
            return self
                .checker
                .ty(id)
                .types()
                .iter()
                .any(|part| self.node_stream_owning_type(*part));
        }
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let info = self.checker.sym(symbol);
        matches!(
            info.name.as_ref(),
            "Readable" | "Writable" | "ReadStream" | "WriteStream"
        ) && info
            .flags
            .intersects(SymbolFlags::CLASS | SymbolFlags::INTERFACE)
            && info.declarations.iter().any(|declaration| {
                let file = source_file_info(source_frontend::prelude::get_source_file_of_node(
                    *declaration,
                ));
                matches!(
                    declaration.kind(),
                    SyntaxKind::ClassDeclaration | SyntaxKind::InterfaceDeclaration
                ) && file.file_name.contains("/@types/node/")
                    && ["/stream.d.ts", "/tty.d.ts", "/fs.d.ts", "/process.d.ts"]
                        .iter()
                        .any(|suffix| file.file_name.ends_with(suffix))
            })
    }

    pub(super) fn web_stream_owning_type(&self, id: TypeId) -> bool {
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::INTERSECTION)
        {
            return self
                .checker
                .ty(id)
                .types()
                .iter()
                .any(|part| self.web_stream_owning_type(*part));
        }
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let info = self.checker.sym(symbol);
        if !matches!(
            info.name.as_ref(),
            "ReadableStream"
                | "ReadableStreamDefaultReader"
                | "ReadableStreamGenericReader"
                | "ReadableStreamReadResult"
                | "ReadableStreamReadDoneResult"
                | "ReadableStreamReadValueResult"
                | "ReadableStreamDefaultReadDoneResult"
                | "ReadableStreamDefaultReadValueResult"
        ) {
            return false;
        }
        info.declarations.iter().any(|declaration| {
            let file = source_file_info(source_frontend::prelude::get_source_file_of_node(
                *declaration,
            ));
            let bundled = source_frontend::frontend::bundled::bundled_lib_name(&file.file_name);
            bundled.is_some_and(|name| name.starts_with("lib.dom"))
                || file.file_name.contains("/bun-types/")
                || file.file_name.ends_with("/@types/node/stream/web.d.ts")
                || file
                    .file_name
                    .ends_with("/@types/node/web-globals/streams.d.ts")
        })
    }

    pub(super) fn process_write(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        let write = match member.kind() {
            SyntaxKind::PropertyAccessExpression => member.name().text() == "write",
            SyntaxKind::ElementAccessExpression => {
                member.argument_expression().kind() == SyntaxKind::StringLiteral
                    && member.argument_expression().text() == "write"
            }
            _ => false,
        };
        if !write {
            return Ok(None);
        }
        let stream = member.expression();
        let name = if self.process_member(stream, "stdout") {
            "stdout.write"
        } else if self.process_member(stream, "stderr") {
            "stderr.write"
        } else {
            return Ok(None);
        };
        // The native sinks complete synchronously and report whether the
        // write was accepted, matching Node's boolean Writable.write result.
        // Callers may discard it or retain it in an arrow/function ABI.
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&arguments.len())
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "process stream write needs a primitive string or native byte buffer and an optional completion callback; encodings and spreads are not ported"));
        }
        let value = self.expression(arguments[0])?;
        let captured_value =
            (arguments.len() == 2).then(|| self.construction_local(value.ty(), false));
        let value_init = captured_value.as_ref().map(|local| Stmt::VarDecl {
            local_id: local.id.clone(),
            init: value.clone(),
            loc: self.loc(arguments[0]),
        });
        let value = captured_value
            .as_ref()
            .map(|local| self.construction_read(local, arguments[0]))
            .unwrap_or(value);
        // An erased chunk (for example a socket `data` listener argument)
        // selects the string or byte sink at runtime; any other value fails
        // the byte check with a TypeError, as Node rejects it.
        let dynamic_write = (value.ty() == Type::Dyn).then(|| {
            let (text, bytes) = if name == "stdout.write" {
                ("process.stdoutWrite", "process.stdoutWriteBytes")
            } else {
                ("process.stderrWrite", "process.stderrWriteBytes")
            };
            let local = self.construction_local(Type::Dyn, false);
            let read = self.construction_read(&local, arguments[0]);
            let loc = self.loc(node);
            Expr::Sequence {
                stmts: vec![Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: value.clone(),
                    loc: self.loc(arguments[0]),
                }],
                result: Box::new(Expr::Ternary {
                    cond: Box::new(Expr::DynTest {
                        value: Box::new(read.clone()),
                        test: "string".into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    }),
                    then: Box::new(Expr::LibCall {
                        r#fn: text.into(),
                        args: vec![Expr::DynCheck {
                            value: Box::new(read.clone()),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }],
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    }),
                    else_: Box::new(Expr::LibCall {
                        r#fn: bytes.into(),
                        args: vec![
                            Expr::DynCheck {
                                value: Box::new(read),
                                r#type: Type::bytes(),
                                loc: loc.clone(),
                            },
                            Expr::StrLit {
                                value: "utf8".into(),
                                r#type: Type::String,
                                loc: loc.clone(),
                            },
                        ],
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    }),
                    r#type: Type::Bool,
                    loc: loc.clone(),
                }),
                r#type: Type::Bool,
                loc,
            }
        });
        let (operation, args) = match value.ty() {
            _ if dynamic_write.is_some() => ("", Vec::new()),
            Type::String => (
                if name == "stdout.write" {
                    "process.stdoutWrite"
                } else {
                    "process.stderrWrite"
                },
                vec![value],
            ),
            Type::Bytes { .. } => (
                if name == "stdout.write" {
                    "process.stdoutWriteBytes"
                } else {
                    "process.stderrWriteBytes"
                },
                vec![
                    value,
                    Expr::StrLit {
                        value: "utf8".into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                ],
            ),
            _ => {
                return Err(self.refuse(
                    node,
                    "process stream write needs a primitive string or native byte buffer",
                ));
            }
        };
        let write = dynamic_write.unwrap_or_else(|| Expr::LibCall {
            r#fn: operation.into(),
            args,
            r#type: Type::Bool,
            loc: self.loc(node),
        });
        let Some(callback_node) = arguments.get(1).copied() else {
            return Ok(Some(write));
        };
        let callback = self.expression(callback_node)?;
        let Type::Func { params, ret, rest } = callback.ty() else {
            return Err(self.refuse(
                callback_node,
                "process stream completion callback needs a native function representation",
            ));
        };
        if rest {
            return Err(self.refuse(
                callback_node,
                "process stream completion callback with a rest parameter is not ported",
            ));
        }
        let write_local = self.construction_local(write.ty(), false);
        let callback_local = self.construction_local(callback.ty(), false);
        let mut callback_args = Vec::with_capacity(params.len());
        for ty in &params {
            let undefined = Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(callback_node),
            };
            callback_args.push(self.coerce(undefined, ty.clone(), callback_node)?);
        }
        let callback_call = Expr::CallValue {
            callee: Box::new(self.construction_read(&callback_local, callback_node)),
            args: callback_args,
            r#type: (*ret).clone(),
            loc: self.loc(node),
        };
        let stmts = vec![
            value_init.expect("callback write captures its value"),
            Stmt::VarDecl {
                local_id: callback_local.id.clone(),
                init: callback,
                loc: self.loc(callback_node),
            },
            Stmt::VarDecl {
                local_id: write_local.id.clone(),
                init: write,
                loc: self.loc(node),
            },
            Stmt::Expression {
                expr: callback_call,
                loc: self.loc(callback_node),
            },
        ];
        Ok(Some(Expr::Sequence {
            stmts,
            result: Box::new(self.construction_read(&write_local, node)),
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }

    pub(super) fn process_member(&mut self, node: Node, name: &str) -> bool {
        let member = match node.kind() {
            SyntaxKind::PropertyAccessExpression => Some(node.name()),
            SyntaxKind::ElementAccessExpression
                if node.argument_expression().kind() == SyntaxKind::StringLiteral =>
            {
                Some(node.argument_expression())
            }
            _ => None,
        };
        if member.is_some_and(|member| member.text() == name)
            && self.native_namespace(node.expression()) == Some("process")
        {
            return true;
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "process" && member == name);
        }
        false
    }

    pub(super) fn process_read(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.process_member(node, "env") {
            return Ok(Some(Expr::LibCall {
                r#fn: "process.envObject".into(),
                args: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }));
        }
        for name in ["version", "arch", "platform", "execPath", "pid", "argv"] {
            if self.process_member(node, name) {
                let property =
                    builtins::property("process", name).expect("registered process property");
                return Ok(Some(Expr::LibCall {
                    r#fn: property.ir.into(),
                    args: vec![],
                    r#type: property.result,
                    loc: self.loc(node),
                }));
            }
        }
        for (name, operation) in [
            ("stdin", "process.stdinValue"),
            ("stdout", "process.stdoutValue"),
            ("stderr", "process.stderrValue"),
        ] {
            if self.process_member(node, name) {
                return Ok(Some(Expr::LibCall {
                    r#fn: operation.into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }));
            }
        }
        if !matches!(
            node.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) {
            return Ok(None);
        }
        let recv = node.expression();
        if self.process_member(recv, "env") {
            let key = if node.kind() == SyntaxKind::PropertyAccessExpression {
                Expr::StrLit {
                    value: node.name().text().into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            } else {
                self.expected_expression(node.argument_expression(), Type::String)?
            };
            let ty = self
                .intern_union(vec![Type::String, Type::Undefined])
                .unwrap();
            return Ok(Some(Expr::LibCall {
                r#fn: "process.envGet".into(),
                args: vec![key],
                r#type: ty,
                loc: self.loc(node),
            }));
        }
        let is_tty = match node.kind() {
            SyntaxKind::PropertyAccessExpression => node.name().text() == "isTTY",
            SyntaxKind::ElementAccessExpression => {
                node.argument_expression().kind() == SyntaxKind::StringLiteral
                    && node.argument_expression().text() == "isTTY"
            }
            _ => false,
        };
        if !is_tty {
            return Ok(None);
        }
        for (stream, fd) in [("stdin", 0.0), ("stdout", 1.0), ("stderr", 2.0)] {
            if !self.process_member(recv, stream) {
                continue;
            }
            let ty = self
                .intern_union(vec![Type::Bool, Type::Undefined])
                .unwrap();
            let Type::Union { union_id } = ty else {
                unreachable!()
            };
            let boolean = self.unions[union_id]
                .arms
                .iter()
                .position(|t| *t == Type::Bool)
                .unwrap();
            let undefined = self.unions[union_id]
                .arms
                .iter()
                .position(|t| *t == Type::Undefined)
                .unwrap();
            let wrap = |tag, value| Expr::UnionWrap {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: ty.clone(),
                loc: self.loc(node),
            };
            let cond = Expr::LibCall {
                r#fn: "process.isTTY".into(),
                args: vec![Expr::NumLit {
                    value: fd,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }],
                r#type: Type::Bool,
                loc: self.loc(node),
            };
            return Ok(Some(Expr::Ternary {
                cond: Box::new(cond),
                then: Box::new(wrap(
                    boolean,
                    Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                )),
                else_: Box::new(wrap(
                    undefined,
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                )),
                r#type: ty,
                loc: self.loc(node),
            }));
        }
        Ok(None)
    }
}
