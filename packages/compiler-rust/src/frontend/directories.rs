//! Directory effects reuse the shared filesystem IR and Rust runtime.
use super::*;

impl Lowerer<'_> {
    pub(super) fn async_directory_call(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty()
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "fs/promises.mkdir needs a string path and no iterable argument spreads",
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let path = self.directory_argument(arguments[0], Type::String, &mut stmts)?;
        let mut mode = Expr::NumLit {
            value: -1.0,
            spelling: None,
            r#type: Type::F64,
            loc: self.loc(node),
        };
        let mut recursive = Expr::BoolLit {
            value: false,
            r#type: Type::Bool,
            loc: self.loc(node),
        };
        if let Some(options) = arguments.get(1).copied() {
            let options = receivers::reference_node(options);
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(
                    options,
                    "fs/promises.mkdir options require a plain recursive/mode object",
                ));
            }
            for property in options.properties() {
                if !matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                ) {
                    return Err(self.refuse(
                        property,
                        "fs/promises.mkdir options require plain recursive/mode properties",
                    ));
                }
                let value = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                    property.name()
                } else {
                    property.initializer()
                };
                let ty = match self.data_property_name(property.name()).as_deref() {
                    Some("mode") => Type::F64,
                    Some("recursive") => Type::Bool,
                    _ => {
                        return Err(self.refuse(
                            property,
                            "fs/promises.mkdir options beyond recursive/mode are not ported",
                        ));
                    }
                };
                let captured = self.directory_argument(value, ty.clone(), &mut stmts)?;
                if ty == Type::F64 {
                    mode = captured;
                } else {
                    recursive = captured;
                }
            }
        }
        for extra in arguments.into_iter().skip(2) {
            stmts.push(Stmt::Expression {
                expr: self.expression(extra)?,
                loc: self.loc(extra),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: "fs.mkdirPromise".into(),
                args: vec![path, mode, recursive],
                r#type: Type::Promise {
                    inner: Box::new(Type::Dyn),
                },
                loc: self.loc(node),
            }),
            r#type: Type::Promise {
                inner: Box::new(Type::Dyn),
            },
            loc: self.loc(node),
        })
    }

    pub(super) fn directory_call(&mut self, node: Node) -> Result<Expr, String> {
        let mut parent = node.parent();
        while parent.kind() == SyntaxKind::ParenthesizedExpression {
            parent = parent.parent();
        }
        if parent.kind() != SyntaxKind::ExpressionStatement {
            return Err(self.refuse(node, "mkdirSync result values require a first-created-directory contract; call it as a statement"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.is_empty()
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "mkdirSync needs a string path and no iterable argument spreads",
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let path = self.directory_argument(arguments[0], Type::String, &mut stmts)?;
        let mut mode = None;
        let mut recursive = false;
        if let Some(options) = arguments.get(1).copied() {
            let options = receivers::reference_node(options);
            if options.kind() == SyntaxKind::ObjectLiteralExpression {
                for property in options.properties() {
                    if !matches!(
                        property.kind(),
                        SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                    ) {
                        return Err(self.refuse(
                            property,
                            "mkdirSync options require plain recursive/mode properties",
                        ));
                    }
                    let value = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                        property.name()
                    } else {
                        property.initializer()
                    };
                    match self.data_property_name(property.name()).as_deref() {
                        Some("mode") => {
                            mode = Some(self.directory_argument(value, Type::F64, &mut stmts)?)
                        }
                        Some("recursive") => {
                            let value = receivers::reference_node(value);
                            recursive = match value.kind() {
                                SyntaxKind::TrueKeyword => true,
                                SyntaxKind::FalseKeyword => false,
                                _ => {
                                    return Err(self.refuse(
                                        value,
                                        "mkdirSync recursive options require a boolean literal",
                                    ));
                                }
                            };
                        }
                        _ => {
                            return Err(self.refuse(
                                property,
                                "mkdirSync options beyond recursive/mode are not ported",
                            ));
                        }
                    }
                }
            } else {
                mode = Some(self.directory_argument(options, Type::F64, &mut stmts)?);
            }
        }
        // Arguments are evaluated before the library validates a mode or path.
        // Unused extras may throw, and must not be dropped or evaluated late.
        for extra in arguments.into_iter().skip(2) {
            stmts.push(Stmt::Expression {
                expr: self.expression(extra)?,
                loc: self.loc(extra),
            });
        }
        let name = match (recursive, mode.is_some()) {
            (false, false) => "fs.mkdirSync",
            (false, true) => "fs.mkdirModeSync",
            (true, false) => "fs.mkdirRecursiveSync",
            (true, true) => "fs.mkdirRecursiveModeSync",
        };
        let mut args = vec![path];
        args.extend(mode);
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: name.into(),
                args,
                r#type: Type::Void,
                loc: self.loc(node),
            }),
            r#type: Type::Void,
            loc: self.loc(node),
        })
    }

    fn directory_argument(
        &mut self,
        node: Node,
        ty: Type,
        stmts: &mut Vec<Stmt>,
    ) -> Result<Expr, String> {
        let value = self.expected_expression(receivers::reference_node(node), ty.clone())?;
        let local = self.construction_local(ty, false);
        stmts.push(Stmt::VarDecl {
            local_id: local.id.clone(),
            init: value,
            loc: self.loc(node),
        });
        Ok(self.construction_read(&local, node))
    }
}
