use super::*;

impl Lowerer<'_> {
    fn sqlite_declaration(&self, declaration: Node) -> bool {
        if declaration.is_nil() {
            return false;
        }
        let file = source_frontend::prelude::get_source_file_of_node(declaration);
        if source_file_info(file).file_name.contains("/bun-types/") {
            return true;
        }
        let mut node = declaration;
        while !node.is_nil() && node.kind() != SyntaxKind::SourceFile {
            if node.kind() == SyntaxKind::ModuleDeclaration
                && matches!(node.name().text(), "bun:sqlite" | "node:sqlite")
            {
                return true;
            }
            node = node.parent();
        }
        false
    }

    pub(super) fn sqlite_database_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0
            || !matches!(
                self.checker.sym(symbol).name.as_ref(),
                "Database" | "DatabaseSync"
            )
        {
            return false;
        }
        self.checker
            .sym(symbol)
            .declarations
            .iter()
            .any(|declaration| self.sqlite_declaration(*declaration))
    }

    fn sqlite_statement_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && matches!(
                self.checker.sym(symbol).name.as_ref(),
                "Statement" | "StatementSync"
            )
            && self
                .checker
                .sym(symbol)
                .declarations
                .iter()
                .any(|declaration| self.sqlite_declaration(*declaration))
    }

    fn sqlite_constructor(&mut self, node: Node) -> Option<&'static str> {
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.native_symbol(node);
        self.native_functions
            .get(&symbol)
            .and_then(|(module, member)| {
                ((*module == "bun:sqlite" && member == "Database")
                    || (*module == "node:sqlite" && member == "DatabaseSync"))
                    .then_some(*module)
            })
    }

    fn sqlite_flags(&mut self, node: Node) -> Result<f64, String> {
        if node.is_nil() {
            return Ok(6.0);
        }
        if node.kind() == SyntaxKind::NumericLiteral {
            return Ok(source_frontend::jsnum::from_string(node.text()).value());
        }
        if node.kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(
                node,
                "Database options require a literal object or numeric flags",
            ));
        }
        let mut readonly = false;
        let mut readwrite = true;
        let mut create = true;
        for property in node.properties() {
            if property.kind() != SyntaxKind::PropertyAssignment
                || !matches!(
                    property.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::StringLiteral
                )
                || !matches!(
                    property.initializer().kind(),
                    SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword
                )
            {
                return Err(self.refuse(
                    property,
                    "Database options require literal boolean properties",
                ));
            }
            let value = property.initializer().kind() == SyntaxKind::TrueKeyword;
            match property.name().text() {
                "readonly" => readonly = value,
                "readOnly" => readonly = value,
                "readwrite" => readwrite = value,
                "create" => create = value,
                // These Node options do not alter the open flags. Their
                // behavior is applied by DatabaseSync methods/runtime setup.
                "allowExtension" | "enableForeignKeyConstraints" | "open" => {}
                "safeIntegers" if !value => {}
                "safeIntegers" => {
                    return Err(self.refuse(
                        property,
                        "Database safeIntegers needs the typed SQLite handle ABI",
                    ));
                }
                _ => return Err(self.refuse(property, "Database option is not ported")),
            }
        }
        Ok(if readonly {
            1.0
        } else {
            f64::from(u8::from(readwrite) * 2 + u8::from(create) * 4)
        })
    }

    pub(super) fn sqlite_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::NewExpression {
            return Ok(None);
        }
        let Some(module) = self.sqlite_constructor(node.expression()) else {
            return Ok(None);
        };
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 2
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "new Database accepts a filename and optional open options",
            ));
        }
        let filename = if let Some(filename) = args.first() {
            self.expected_expression(*filename, Type::String)?
        } else {
            Expr::StrLit {
                value: ":memory:".into(),
                r#type: Type::String,
                loc: self.loc(node),
            }
        };
        if module == "node:sqlite" {
            let options = if let Some(options) = args.get(1) {
                self.expected_expression(*options, Type::Dyn)?
            } else {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?
            };
            return Ok(Some(Expr::LibCall {
                r#fn: "sqlite.open.node".into(),
                args: vec![filename, options],
                r#type: Type::F64,
                loc: self.loc(node),
            }));
        }
        let flags = self.sqlite_flags(args.get(1).copied().unwrap_or(Node::NIL))?;
        Ok(Some(Expr::LibCall {
            r#fn: "sqlite.open".into(),
            args: vec![
                filename,
                Expr::NumLit {
                    value: flags,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                },
            ],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    pub(super) fn sqlite_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let access = node.expression();
        if access.kind() != SyntaxKind::PropertyAccessExpression
            || !access.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let receiver_id = self.checker.get_type_at_location(access.expression());
        if self.sqlite_statement_type(receiver_id) {
            let receiver = self.expected_expression(access.expression(), Type::F64)?;
            let name = access.name().text();
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            let (operation, result, args) = match name {
                "setReadBigInts" | "setReturnArrays" if arguments.len() == 1 => (
                    if name == "setReadBigInts" {
                        "sqlite.statementSafe"
                    } else {
                        "sqlite.statementArrays"
                    },
                    Type::Void,
                    vec![
                        receiver,
                        self.expected_expression(arguments[0], Type::Bool)?,
                    ],
                ),
                "all" | "get" | "run" | "iterate" => {
                    let mut args = vec![receiver];
                    args.extend(self.rest_method_arguments(
                        node,
                        &[Type::Array {
                            elem: Box::new(Type::Dyn),
                        }],
                        true,
                    )?);
                    (
                        match name {
                            "all" => "sqlite.statementAll",
                            "get" => "sqlite.statementGet",
                            "run" => "sqlite.statementRun",
                            _ => "sqlite.statementIterate",
                        },
                        Type::Dyn,
                        args,
                    )
                }
                _ => {
                    return Err(self.refuse(
                        node,
                        &format!("node:sqlite StatementSync.{name} overload is not ported"),
                    ));
                }
            };
            return Ok(Some(Expr::LibCall {
                r#fn: operation.into(),
                args,
                r#type: result,
                loc: self.loc(node),
            }));
        }
        if !self.sqlite_database_type(receiver_id) {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let (operation, result, mut args) = match access.name().text() {
            "close" if arguments.is_empty() => ("sqlite.close", Type::Void, Vec::new()),
            "serialize" if arguments.is_empty() => ("sqlite.serialize", Type::bytes(), Vec::new()),
            "exec" if arguments.len() == 1 => (
                "sqlite.exec",
                Type::Void,
                vec![self.expected_expression(arguments[0], Type::String)?],
            ),
            "prepare" if arguments.len() == 1 => (
                "sqlite.prepare",
                Type::F64,
                vec![self.expected_expression(arguments[0], Type::String)?],
            ),
            "close" | "serialize" | "exec" | "prepare" => {
                return Err(self.refuse(node, "this Database method overload is not ported"));
            }
            name => return Err(self.refuse(node, &format!("Database.{name} is not ported"))),
        };
        let receiver = self.expression(access.expression())?;
        if receiver.ty() != Type::F64 {
            return Err(self.refuse(
                access.expression(),
                "Database handle lost its native identity",
            ));
        }
        args.insert(0, receiver);
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args,
            r#type: result,
            loc: self.loc(node),
        }))
    }
}
