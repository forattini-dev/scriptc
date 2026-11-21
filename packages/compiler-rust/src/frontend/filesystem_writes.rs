//! File publication effects normalize options before calling the shared FS ABI.
use super::*;

impl Lowerer<'_> {
    pub(super) fn remove_call(&mut self, node: Node) -> Result<Expr, String> {
        self.remove_call_impl(node, false)
    }

    pub(super) fn async_remove_call(&mut self, node: Node) -> Result<Expr, String> {
        self.remove_call_impl(node, true)
    }

    fn remove_call_impl(&mut self, node: Node, promise: bool) -> Result<Expr, String> {
        let api = if promise { "fs/promises.rm" } else { "rmSync" };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty()
            || arguments.len() > 2
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                &format!("{api} requires a path and optional inline options without spreads"),
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let path = self.filesystem_argument(
            arguments[0],
            Type::String,
            &format!("{api} requires a represented string path"),
            &mut stmts,
        )?;
        let mut recursive = false;
        let mut force = false;
        let mut has_options = false;
        if let Some(options) = arguments.get(1).copied() {
            let options = receivers::reference_node(options);
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(
                    options,
                    &format!("{api} options must be a plain inline object"),
                ));
            }
            has_options = true;
            for property in options.properties() {
                if property.kind() != SyntaxKind::PropertyAssignment {
                    return Err(self.refuse(
                        property,
                        &format!("{api} options require plain data properties"),
                    ));
                }
                let value = receivers::reference_node(property.initializer());
                let boolean = match value.kind() {
                    SyntaxKind::TrueKeyword => true,
                    SyntaxKind::FalseKeyword => false,
                    _ => {
                        return Err(self.refuse(
                            value,
                            &format!("{api} recursive and force options must be literal booleans"),
                        ));
                    }
                };
                match self.data_property_name(property.name()).as_deref() {
                    Some("recursive") => recursive = boolean,
                    Some("force") => force = boolean,
                    _ => {
                        return Err(self.refuse(
                            property,
                            &format!("{api} supports only recursive and force options"),
                        ));
                    }
                }
            }
        }
        let result = if promise {
            Expr::LibCall {
                r#fn: "fs.rmPromise".into(),
                args: vec![
                    path,
                    Expr::BoolLit {
                        value: recursive,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                    Expr::BoolLit {
                        value: force,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                ],
                r#type: Type::Promise {
                    inner: Box::new(Type::Void),
                },
                loc: self.loc(node),
            }
        } else if has_options {
            Expr::LibCall {
                r#fn: "fs.rmOptionsSync".into(),
                args: vec![
                    path,
                    Expr::BoolLit {
                        value: recursive,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                    Expr::BoolLit {
                        value: force,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                ],
                r#type: Type::Void,
                loc: self.loc(node),
            }
        } else {
            Expr::LibCall {
                r#fn: "fs.rmSync".into(),
                args: vec![path],
                r#type: Type::Void,
                loc: self.loc(node),
            }
        };
        let result_type = result.ty();
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn append_file_call(&mut self, node: Node) -> Result<Expr, String> {
        self.file_write_call(node, true, false)
    }

    pub(super) fn write_file_call(&mut self, node: Node) -> Result<Expr, String> {
        self.file_write_call(node, false, false)
    }

    pub(super) fn async_write_file_call(&mut self, node: Node) -> Result<Expr, String> {
        self.file_write_call(node, false, true)
    }

    pub(super) fn async_append_file_call(&mut self, node: Node) -> Result<Expr, String> {
        self.file_write_call(node, true, true)
    }

    fn file_write_call(&mut self, node: Node, append: bool, promise: bool) -> Result<Expr, String> {
        let operation = if promise && append {
            "fs/promises.appendFile"
        } else if promise {
            "fs/promises.writeFile"
        } else if append {
            "appendFileSync"
        } else {
            "writeFileSync"
        };
        let argument_requirement = if promise {
            "fs/promises.writeFile needs represented string path/data and numeric mode"
        } else if append {
            "appendFileSync needs represented string path/data and numeric mode"
        } else {
            "writeFileSync needs represented string path/data and numeric mode"
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() < 2
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                &format!("{operation} needs path/data arguments without spreads"),
            ));
        }
        self.ensure_exception_classes(node)?;
        if !promise && self.ty(arguments[0]).ok() == Some(Type::F64) {
            if arguments.len() != 2 {
                return Err(self.refuse(
                    node,
                    &format!("descriptor {operation} options and extra arguments are not ported"),
                ));
            }
            let fd = self.expected_expression(arguments[0], Type::F64)?;
            let data = self.expected_expression(arguments[1], Type::String)?;
            return Ok(Expr::LibCall {
                r#fn: if append {
                    "fs.appendFileFdSync"
                } else {
                    "fs.writeFileFdSync"
                }
                .into(),
                args: vec![fd, data],
                r#type: Type::Void,
                loc: self.loc(node),
            });
        }
        let mut stmts = Vec::new();
        let path =
            self.filesystem_argument(arguments[0], Type::String, argument_requirement, &mut stmts)?;
        let data_type = if self.ty(arguments[1]).ok() == Some(Type::bytes()) {
            if append || promise {
                return Err(self.refuse(
                    arguments[1],
                    &format!("{operation} byte data is not ported yet"),
                ));
            }
            Type::bytes()
        } else {
            Type::String
        };
        let data = self.filesystem_argument(
            arguments[1],
            data_type.clone(),
            argument_requirement,
            &mut stmts,
        )?;
        let mut mode = None;
        let mut exclusive = false;
        let mut append_flag = false;
        let mut flush = false;
        if let Some(options) = arguments.get(2).copied() {
            let options = receivers::reference_node(options);
            if options.kind() == SyntaxKind::ObjectLiteralExpression {
                for property in options.properties() {
                    if !matches!(
                        property.kind(),
                        SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                    ) {
                        return Err(self.refuse(
                            property,
                            "appendFileSync options require plain data properties",
                        ));
                    }
                    let value = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                        property.name()
                    } else {
                        property.initializer()
                    };
                    let literal = receivers::reference_node(value);
                    match self.data_property_name(property.name()).as_deref() {
                        Some("mode") => mode = Some(self.filesystem_argument(value, Type::F64, argument_requirement, &mut stmts)?),
                        Some("encoding") if Self::filesystem_utf8_literal(literal) => {},
                        Some("flag") if literal.kind() == SyntaxKind::StringLiteral && literal.text() == if append { "a" } else { "w" } => {},
                        Some("flag") if promise && !append && literal.kind() == SyntaxKind::StringLiteral && literal.text() == "a" => append_flag = true,
                        Some("flag") if !append && literal.kind() == SyntaxKind::StringLiteral && literal.text() == "wx" => exclusive = true,
                        Some("flush") if literal.kind() == SyntaxKind::FalseKeyword => {},
                        Some("flush") if promise && !append && literal.kind() == SyntaxKind::TrueKeyword => flush = true,
                        _ => return Err(self.refuse(property, &format!("{operation} options require literal utf8/utf-8 encoding, numeric mode, literal {} flag or supported literal flush", if append { "a" } else { "w/wx" }))),
                    }
                }
            } else if !Self::filesystem_utf8_literal(options) {
                let value = self.expression(options)?;
                if !matches!(value.ty(), Type::Null | Type::Undefined) {
                    return Err(self.refuse(
                        options,
                        &format!(
                            "{operation} requires inline options or literal utf8/utf-8 encoding"
                        ),
                    ));
                }
                stmts.push(Stmt::Expression {
                    expr: self.coerce(value, Type::Dyn, options)?,
                    loc: self.loc(options),
                });
            }
        }
        // Even ignored arguments and overwritten option values execute before I/O.
        for extra in arguments.into_iter().skip(3) {
            let value = self.expression(extra)?;
            stmts.push(Stmt::Expression {
                expr: value,
                loc: self.loc(extra),
            });
        }
        if exclusive && mode.is_none() {
            mode = Some(Expr::NumLit {
                value: 0o666 as f64,
                spelling: Some("0o666".into()),
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        let name = if promise && (append || append_flag) {
            "fs.appendFilePromise"
        } else if promise {
            "fs.writeFilePromise"
        } else if data_type == Type::bytes() && exclusive {
            "fs.writeFileBytesExclusiveModeSync"
        } else if data_type == Type::bytes() && mode.is_some() {
            "fs.writeFileBytesModeSync"
        } else if data_type == Type::bytes() {
            "fs.writeFileBytesSync"
        } else if append && mode.is_some() {
            "fs.appendFileModeSync"
        } else if append {
            "fs.appendFileSync"
        } else if exclusive {
            "fs.writeFileExclusiveModeSync"
        } else if mode.is_some() {
            "fs.writeFileModeSync"
        } else {
            "fs.writeFileSync"
        };
        let mut args = vec![path, data];
        if promise {
            args.push(mode.unwrap_or(Expr::NumLit {
                value: if append || append_flag {
                    0o666 as f64
                } else {
                    -1.0
                },
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            }));
            args.push(Expr::BoolLit {
                value: exclusive,
                r#type: Type::Bool,
                loc: self.loc(node),
            });
            if !append && !append_flag {
                args.push(Expr::BoolLit {
                    value: flush,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
        } else if let Some(mode) = mode {
            args.push(mode);
            if append {
                args.push(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
        }
        let result_type = if promise {
            Type::Promise {
                inner: Box::new(Type::Void),
            }
        } else {
            Type::Void
        };
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: name.into(),
                args,
                r#type: result_type.clone(),
                loc: self.loc(node),
            }),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn filesystem_utf8_literal(node: Node) -> bool {
        node.kind() == SyntaxKind::StringLiteral && matches!(node.text(), "utf8" | "utf-8")
    }

    pub(super) fn filesystem_argument(
        &mut self,
        node: Node,
        ty: Type,
        requirement: &str,
        stmts: &mut Vec<Stmt>,
    ) -> Result<Expr, String> {
        let value = self.expression(receivers::reference_node(node))?;
        // Filesystem APIs consume a checked native view, not necessarily the
        // expression's owning storage. Generic helpers and indexed records can
        // deliberately keep that storage as NativeValue even when TypeScript
        // proves the returned value is a string or number. Install the same
        // runtime-checked view used at ordinary typed call boundaries; this
        // rejects a wrong live value instead of applying JavaScript ToString.
        let value = self
            .coerce(value, ty.clone(), node)
            .map_err(|_| self.refuse(node, requirement))?;
        let local = self.construction_local(ty, false);
        stmts.push(Stmt::VarDecl {
            local_id: local.id.clone(),
            init: value,
            loc: self.loc(node),
        });
        Ok(self.construction_read(&local, node))
    }
}
