//! Descriptor source overloads normalize to the shared portable filesystem ABI.
use super::*;

impl Lowerer<'_> {
    pub(super) fn async_numeric_open_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let source = node.arguments().into_iter().collect::<Vec<_>>();
        if source.len() < 2 || self.ty(source[1]).ok() != Some(Type::F64) {
            return Ok(None);
        }
        if source.len() > 3
            || source
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "numeric fs.promises.open requires two or three fixed arguments",
            ));
        }
        self.ensure_exception_classes(node)?;
        let path = self.expected_expression(source[0], Type::String)?;
        let flags = self.expected_expression(source[1], Type::F64)?;
        let mode = if let Some(argument) = source.get(2) {
            self.expected_expression(*argument, Type::F64)?
        } else {
            Expr::NumLit {
                value: 0o666 as f64,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            }
        };
        Ok(Some(Expr::LibCall {
            r#fn: "fs.openNumericPromise".into(),
            args: vec![path, flags, mode],
            r#type: Type::Promise {
                inner: Box::new(Type::Dyn),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn copy_call(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !(2..=3).contains(&arguments.len())
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "cpSync requires source, destination and at most one plain options object",
            ));
        }
        self.ensure_exception_classes(node)?;
        let from = self.expected_expression(arguments[0], Type::String)?;
        let to = self.expected_expression(arguments[1], Type::String)?;
        // Materialize call operands in JavaScript order before arranging the
        // fixed native ABI. Option properties may be arbitrary boolean
        // expressions, not just literals.
        let from_local = self.construction_local(Type::String, false);
        let to_local = self.construction_local(Type::String, false);
        let mut stmts = vec![
            Stmt::VarDecl {
                local_id: from_local.id.clone(),
                init: from,
                loc: self.loc(arguments[0]),
            },
            Stmt::VarDecl {
                local_id: to_local.id.clone(),
                init: to,
                loc: self.loc(arguments[1]),
            },
        ];
        let mut recursive = Expr::BoolLit {
            value: false,
            r#type: Type::Bool,
            loc: self.loc(node),
        };
        let mut dereference = recursive.clone();
        let callback_type = Type::Func {
            params: vec![Type::String, Type::String],
            ret: Box::new(Type::Bool),
            rest: false,
        };
        let mut filter = None;
        if let Some(options) = arguments.get(2).copied() {
            let options = receivers::reference_node(options);
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(options, "cpSync options require a plain object literal"));
            }
            for property in options.properties() {
                if property.kind() != SyntaxKind::PropertyAssignment {
                    return Err(self.refuse(
                        property,
                        "cpSync options require named recursive/dereference/filter properties",
                    ));
                }
                let name = self.data_property_name(property.name());
                if !matches!(
                    name.as_deref(),
                    Some("recursive" | "dereference" | "filter")
                ) {
                    return Err(self.refuse(
                        property,
                        "cpSync options beyond recursive/dereference/filter are not ported",
                    ));
                }
                let ty = if name.as_deref() == Some("filter") {
                    callback_type.clone()
                } else {
                    Type::Bool
                };
                let value = self.expected_expression(property.initializer(), ty.clone())?;
                let local = self.construction_local(ty, false);
                stmts.push(Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: value,
                    loc: self.loc(property.initializer()),
                });
                let value = self.construction_read(&local, property.initializer());
                match name.as_deref() {
                    Some("recursive") => recursive = value,
                    Some("dereference") => dereference = value,
                    Some("filter") => filter = Some(value),
                    _ => {
                        unreachable!("validated cpSync option")
                    }
                }
            }
        }
        let mut args = vec![
            self.construction_read(&from_local, arguments[0]),
            self.construction_read(&to_local, arguments[1]),
            recursive,
            dereference,
        ];
        let r#fn = if let Some(filter) = filter {
            args.push(filter);
            "fs.cpSyncFiltered"
        } else {
            "fs.cpSync"
        };
        let call = Expr::LibCall {
            r#fn: r#fn.into(),
            args,
            r#type: Type::Void,
            loc: self.loc(node),
        };
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(call),
            r#type: Type::Void,
            loc: self.loc(node),
        })
    }

    fn fs_constants_object(&mut self, node: Node) -> bool {
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, name)| *module == "fs" && name == "constants");
        }
        node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "constants"
            && self.native_namespace(node.expression()) == Some("fs")
    }

    pub(super) fn fs_flag_constant(
        &mut self,
        node: Node,
        nofollow_fallback: bool,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || !self.fs_constants_object(node.expression())
        {
            return Ok(None);
        }
        let name = node.name().text();
        if let Some(value) = match name {
            "F_OK" => Some(0.0),
            "R_OK" => Some(4.0),
            "W_OK" => Some(2.0),
            "X_OK" => Some(1.0),
            _ => None,
        } {
            return Ok(Some(Expr::NumLit {
                value,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        if name == "O_NOFOLLOW" && !nofollow_fallback {
            return Err(self.refuse(
                node,
                "O_NOFOLLOW can be undefined; only the explicit ?? 0 fallback is represented",
            ));
        }
        if !matches!(
            name,
            "O_RDONLY"
                | "O_WRONLY"
                | "O_RDWR"
                | "O_CREAT"
                | "O_EXCL"
                | "O_TRUNC"
                | "O_APPEND"
                | "O_NOFOLLOW"
        ) {
            return Err(self.refuse(node, "filesystem constant is not ported"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: "fs.openFlagConstant".into(),
            args: vec![Expr::StrLit {
                value: name.to_string(),
                r#type: Type::String,
                loc: self.loc(node),
            }],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    pub(super) fn descriptor_call(&mut self, node: Node, member: &str) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let source = node.arguments().into_iter().collect::<Vec<_>>();
        if source
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "descriptor argument spreads are not ported"));
        }
        let mut args = Vec::new();
        match member {
            "openSync" if (1..=3).contains(&source.len()) => {
                let path = self.expression(source[0])?;
                if path.ty() != Type::String {
                    return Err(self.refuse(node, "openSync requires a represented string path"));
                }
                args.push(path);
                if let Some(flag) = source.get(1)
                    && self.ty(*flag).ok() == Some(Type::F64)
                {
                    args.push(self.expression(*flag)?);
                    let mode = if let Some(mode) = source.get(2) {
                        self.expression(*mode)?
                    } else {
                        Expr::NumLit {
                            value: 0o666 as f64,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        }
                    };
                    if mode.ty() != Type::F64 {
                        return Err(self
                            .refuse(node, "numeric openSync mode requires a represented number"));
                    }
                    args.push(mode);
                    return Ok(Expr::LibCall {
                        r#fn: "fs.openNumericSync".into(),
                        args,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    });
                }
                let flags = if let Some(arg) = source.get(1) {
                    let literal = receivers::reference_node(*arg);
                    if literal.kind() != SyntaxKind::StringLiteral
                        || !matches!(
                            literal.text(),
                            "r" | "r+"
                                | "w"
                                | "w+"
                                | "wx"
                                | "xw"
                                | "wx+"
                                | "xw+"
                                | "a"
                                | "a+"
                                | "ax"
                                | "xa"
                                | "ax+"
                                | "xa+"
                        )
                    {
                        return Err(self.refuse(node, "openSync flags require a basic literal string; synchronous/numeric/dynamic flags are not ported"));
                    }
                    self.expression(*arg)?
                } else {
                    Expr::StrLit {
                        value: "r".into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    }
                };
                args.push(flags);
                if let Some(mode) = source.get(2) {
                    let mode = self.expression(*mode)?;
                    if mode.ty() != Type::F64 {
                        return Err(
                            self.refuse(node, "openSync mode requires a represented number")
                        );
                    }
                    args.push(mode);
                    return Ok(Expr::LibCall {
                        r#fn: "fs.openModeSync".into(),
                        args,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    });
                }
            }
            "closeSync" if source.len() == 1 => {
                let value = self.expression(source[0])?;
                if let Type::Union { union_id } = value.ty() {
                    let arms = self.unions[union_id].arms.clone();
                    if arms
                        .iter()
                        .all(|arm| matches!(arm, Type::F64 | Type::Null | Type::Undefined))
                        && arms.contains(&Type::F64)
                    {
                        let mut helper = helpers::Helper::new(
                            "close_nullable_descriptor",
                            vec![value.ty()],
                            Type::Void,
                            self.loc(node),
                        );
                        for (tag, arm) in arms.iter().enumerate() {
                            let read = helper.read(&helper.param(0));
                            let call = if *arm == Type::F64 {
                                Expr::LibCall {
                                    r#fn: "fs.closeSync".into(),
                                    args: vec![Expr::UnionNarrow {
                                        union_id: format!("u{union_id}"),
                                        tag,
                                        value: Box::new(read.clone()),
                                        r#type: Type::F64,
                                        loc: helper.loc(),
                                    }],
                                    r#type: Type::Void,
                                    loc: helper.loc(),
                                }
                            } else {
                                Expr::LibCall {
                                    r#fn: "fs.closeNullish".into(),
                                    args: vec![Expr::StrLit {
                                        value: if *arm == Type::Null {
                                            "null"
                                        } else {
                                            "undefined"
                                        }
                                        .into(),
                                        r#type: Type::String,
                                        loc: helper.loc(),
                                    }],
                                    r#type: Type::Void,
                                    loc: helper.loc(),
                                }
                            };
                            helper.function.body.push(Stmt::If {
                                cond: Expr::UnionIsTag {
                                    union_id: format!("u{union_id}"),
                                    tag,
                                    value: Box::new(read),
                                    negated: false,
                                    r#type: Type::Bool,
                                    loc: helper.loc(),
                                },
                                then: vec![
                                    Stmt::Expression {
                                        expr: call,
                                        loc: helper.loc(),
                                    },
                                    Stmt::Return {
                                        value: None,
                                        loc: helper.loc(),
                                    },
                                ],
                                else_: None,
                                loc: helper.loc(),
                            });
                        }
                        let callee = self.install_helper(helper.function);
                        return Ok(Expr::Call {
                            callee,
                            args: vec![value],
                            r#type: Type::Void,
                            loc: self.loc(node),
                        });
                    }
                }
                args.push(value);
            }
            "ftruncateSync" if (1..=2).contains(&source.len()) => {
                args.push(self.expression(source[0])?);
                args.push(if let Some(length) = source.get(1) {
                    self.expression(*length)?
                } else {
                    Expr::NumLit {
                        value: 0.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: self.loc(node),
                    }
                });
            }
            "writeSync" if source.len() == 2 => {
                let fd = self.expression(source[0])?;
                let bytes = self.expression(source[1])?;
                if fd.ty() != Type::F64 || bytes.ty() != Type::bytes() {
                    return Err(self.refuse(
                        node,
                        "writeSync requires a numeric descriptor and a u8 view",
                    ));
                }
                let mut helper = helpers::Helper::new(
                    "write_descriptor",
                    vec![Type::F64, Type::bytes()],
                    Type::F64,
                    self.loc(node),
                );
                let data = helper.read(&helper.param(1));
                let length = Expr::BytesIntrinsic {
                    method: "length".into(),
                    receiver: Box::new(data.clone()),
                    args: vec![],
                    r#type: Type::F64,
                    loc: helper.loc(),
                };
                let result = Expr::LibCall {
                    r#fn: "fs.writeSync".into(),
                    args: vec![
                        helper.read(&helper.param(0)),
                        data,
                        helper.number(0.0),
                        length,
                        helper.number(-1.0),
                    ],
                    r#type: Type::F64,
                    loc: helper.loc(),
                };
                helper.function.body.push(Stmt::Return {
                    value: Some(result),
                    loc: helper.loc(),
                });
                let callee = self.install_helper(helper.function);
                return Ok(Expr::Call {
                    callee,
                    args: vec![fd, bytes],
                    r#type: Type::F64,
                    loc: self.loc(node),
                });
            }
            "readSync" if (4..=5).contains(&source.len()) => {
                for arg in &source[..4] {
                    args.push(self.expression(*arg)?);
                }
                let position = source.get(4).map(|arg| self.expression(*arg)).transpose()?;
                args.push(match position {
                    Some(value) if value.ty() == Type::F64 => value,
                    value
                        if value
                            .as_ref()
                            .is_none_or(|v| matches!(v.ty(), Type::Null | Type::Undefined)) =>
                    {
                        let current = Expr::NumLit {
                            value: -1.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        };
                        if let Some(value) = value {
                            Expr::Sequence {
                                stmts: vec![Stmt::Expression {
                                    expr: self.coerce(value, Type::Dyn, node)?,
                                    loc: self.loc(node),
                                }],
                                result: Box::new(current),
                                r#type: Type::F64,
                                loc: self.loc(node),
                            }
                        } else {
                            current
                        }
                    }
                    _ => {
                        return Err(self.refuse(
                            node,
                            "readSync position needs a represented number, null or undefined",
                        ));
                    }
                });
            }
            _ => return Err(self.refuse(node, "descriptor overload is not ported")),
        }
        let api = builtins::source("fs", member).expect("descriptor registry");
        let operation = &api.operations[0];
        if args.len() != operation.args.len()
            || args
                .iter()
                .zip(&operation.args)
                .any(|(arg, ty)| arg.ty() != *ty)
        {
            return Err(self.refuse(
                node,
                &format!(
                    "descriptor arguments need represented numeric slots and u8 views; got {:?}",
                    args.iter().map(Expr::ty).collect::<Vec<_>>()
                ),
            ));
        }
        Ok(Expr::LibCall {
            r#fn: operation.ir.into(),
            args,
            r#type: operation.result.clone(),
            loc: self.loc(node),
        })
    }
}
