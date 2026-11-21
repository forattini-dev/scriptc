//! Narrow native subprocess contract. Unsupported options remain explicit.
use super::*;

impl Lowerer<'_> {
    pub(super) fn bun_shell_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let nothrow = primitives::primitive_source(node.expression());
        if nothrow.kind() != SyntaxKind::PropertyAccessExpression
            || nothrow.name().text() != "nothrow"
            || !node.arguments().is_empty()
        {
            return Ok(None);
        }
        let quiet_call = primitives::primitive_source(nothrow.expression());
        if quiet_call.kind() != SyntaxKind::CallExpression || !quiet_call.arguments().is_empty() {
            return Ok(None);
        }
        let quiet = primitives::primitive_source(quiet_call.expression());
        if quiet.kind() != SyntaxKind::PropertyAccessExpression || quiet.name().text() != "quiet" {
            return Ok(None);
        }
        let tagged = primitives::primitive_source(quiet.expression());
        if tagged.kind() != SyntaxKind::TaggedTemplateExpression {
            return Ok(None);
        }
        let tag = primitives::primitive_source(tagged.tag());
        if tag.kind() != SyntaxKind::PropertyAccessExpression
            || tag.name().text() != "$"
            || self.native_namespace(tag.expression()) != Some("Bun")
        {
            return Ok(None);
        }

        let template = tagged.template();
        let cooked = |part: Node| -> Result<String, String> {
            let bytes = source_frontend::scanner_util::go_string_bytes(part.text());
            std::str::from_utf8(&bytes)
                .map(str::to_owned)
                .map_err(|_| self.refuse(part, "lone UTF-16 surrogates are not ported"))
        };
        let (head, spans) = if template.kind() == SyntaxKind::NoSubstitutionTemplateLiteral {
            (cooked(template)?, Vec::new())
        } else if template.kind() == SyntaxKind::TemplateExpression {
            (
                cooked(template.head())?,
                template
                    .template_spans()
                    .nodes()
                    .into_iter()
                    .map(|span| Ok((span.expression(), cooked(span.literal())?)))
                    .collect::<Result<Vec<_>, String>>()?,
            )
        } else {
            return Err(self.refuse(tagged, "Bun.$ requires a template literal"));
        };

        let loc = self.loc(tagged);
        let literal = |value: String| Expr::StrLit {
            value,
            r#type: Type::String,
            loc: loc.clone(),
        };
        let mut argv = Vec::new();
        let mut current: Option<Expr> = None;
        let mut text = String::new();
        let flush_text = |current: &mut Option<Expr>, text: &mut String| {
            if text.is_empty() {
                return;
            }
            let value = literal(std::mem::take(text));
            *current = Some(match current.take() {
                Some(prefix) => Expr::StrConcat {
                    left: Box::new(prefix),
                    right: Box::new(value),
                    r#type: Type::String,
                    loc: loc.clone(),
                },
                None => value,
            });
        };
        let finish_word = |argv: &mut Vec<Expr>, current: &mut Option<Expr>| {
            if let Some(word) = current.take() {
                argv.push(word);
            }
        };
        let consume = |part: &str,
                       argv: &mut Vec<Expr>,
                       current: &mut Option<Expr>,
                       text: &mut String|
         -> Result<(), ()> {
            for character in part.chars() {
                if character.is_whitespace() {
                    flush_text(current, text);
                    finish_word(argv, current);
                } else if matches!(
                    character,
                    '\'' | '"' | '`' | '\\' | ';' | '|' | '&' | '<' | '>' | '$' | '(' | ')'
                ) {
                    return Err(());
                } else {
                    text.push(character);
                }
            }
            Ok(())
        };

        consume(&head, &mut argv, &mut current, &mut text).map_err(|()| {
            self.refuse(
                tagged,
                "Bun.$ native argv subset does not accept shell operators or quoting",
            )
        })?;
        for (source, tail) in spans {
            flush_text(&mut current, &mut text);
            let value = self.expected_expression(source, Type::String)?;
            current = Some(match current.take() {
                Some(prefix) => self.string_concat(prefix, value, tagged),
                None => value,
            });
            consume(&tail, &mut argv, &mut current, &mut text).map_err(|()| {
                self.refuse(
                    tagged,
                    "Bun.$ native argv subset does not accept shell operators or quoting",
                )
            })?;
        }
        flush_text(&mut current, &mut text);
        finish_word(&mut argv, &mut current);
        if argv.is_empty() {
            return Err(self.refuse(tagged, "Bun.$ native argv subset requires a command"));
        }
        self.ensure_exception_classes(node)?;
        Ok(Some(Expr::LibCall {
            r#fn: "bun.shellQuietNothrow".into(),
            args: vec![Expr::ArrayLit {
                elems: argv,
                r#type: Type::Array {
                    elem: Box::new(Type::String),
                },
                loc: loc.clone(),
            }],
            r#type: Type::Promise {
                inner: Box::new(Type::F64),
            },
            loc,
        }))
    }

    pub(super) fn bun_connect(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 || arguments[0].kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(
                node,
                "Bun.connect requires one literal hostname/port/socket options object",
            ));
        }
        let options = arguments[0];
        let mut host = None;
        let mut port = None;
        let mut socket = None;
        for property in options.properties() {
            if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                match property.name().text().as_ref() {
                    "hostname" => {
                        host = Some(self.expected_expression(property.name(), Type::String)?)
                    }
                    "port" => port = Some(self.expected_expression(property.name(), Type::F64)?),
                    _ => return Err(self.refuse(property, "Bun.connect option is not ported")),
                }
                continue;
            }
            if property.kind() != SyntaxKind::PropertyAssignment
                || !matches!(
                    property.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::StringLiteral
                )
            {
                return Err(self.refuse(property, "Bun.connect requires named literal options"));
            }
            match property.name().text().as_ref() {
                "hostname" => {
                    host = Some(self.expected_expression(property.initializer(), Type::String)?)
                }
                "port" => port = Some(self.expected_expression(property.initializer(), Type::F64)?),
                "socket" => socket = Some(property.initializer()),
                _ => return Err(self.refuse(property, "Bun.connect option is not ported")),
            }
        }
        let host = host.ok_or_else(|| self.refuse(options, "Bun.connect requires hostname"))?;
        let port = port.ok_or_else(|| self.refuse(options, "Bun.connect requires port"))?;
        let socket =
            socket.ok_or_else(|| self.refuse(options, "Bun.connect requires socket handlers"))?;
        if socket.kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(
                socket,
                "Bun.connect socket handlers must be a literal object",
            ));
        }

        let mut handlers: HashMap<String, Expr> = HashMap::new();
        for property in socket.properties() {
            if !matches!(
                property.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
            ) || !matches!(
                property.name().kind(),
                SyntaxKind::Identifier | SyntaxKind::StringLiteral
            ) {
                return Err(self.refuse(property, "Bun.connect requires named function handlers"));
            }
            let name = property.name().text().to_string();
            if !matches!(
                name.as_str(),
                "open" | "data" | "close" | "error" | "connectError"
            ) {
                return Err(self.refuse(property, "Bun.connect socket handler is not ported"));
            }
            let callback = if property.kind() == SyntaxKind::MethodDeclaration {
                property
            } else {
                property.initializer()
            };
            if !matches!(
                callback.kind(),
                SyntaxKind::ArrowFunction
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::MethodDeclaration
            ) {
                return Err(self.refuse(callback, "Bun.connect handler must be a function"));
            }
            let signature = Type::Func {
                params: vec![Type::Dyn; callback.parameters().len()],
                ret: Box::new(Type::Void),
                rest: false,
            };
            let callback = self.closure(callback, Some(signature))?;
            handlers.insert(name, self.coerce(callback, Type::Dyn, property)?);
        }
        let mut values = vec![host, port];
        for name in ["open", "data", "close", "error", "connectError"] {
            values.push(handlers.remove(name).unwrap_or_else(|| {
                let undefined = Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(socket),
                };
                self.coerce(undefined, Type::Dyn, socket)
                    .expect("undefined always has a dynamic owning view")
            }));
        }
        self.ensure_exception_classes(node)?;
        Ok(Expr::LibCall {
            r#fn: "bun.connect".into(),
            args: values,
            r#type: Type::Promise {
                inner: Box::new(Type::Dyn),
            },
            loc: self.loc(node),
        })
    }

    pub(super) fn bun_file_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "BunFile"
            && self
                .checker
                .sym(symbol)
                .declarations
                .iter()
                .any(|declaration| {
                    !declaration.is_nil()
                        && source_file_info(source_frontend::prelude::get_source_file_of_node(
                            *declaration,
                        ))
                        .file_name
                        .contains("bun-types")
                })
    }

    pub(super) fn bun_file(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "Bun.file requires one represented string path"));
        }
        let path = self.expected_expression(arguments[0], Type::String)?;
        self.ensure_exception_classes(node)?;
        Ok(Expr::LibCall {
            r#fn: "bun.filePath".into(),
            args: vec![path],
            r#type: Type::String,
            loc: self.loc(node),
        })
    }

    pub(super) fn bun_file_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = primitives::primitive_source(node.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
            || !node.arguments().is_empty()
            || !matches!(member.name().text(), "text" | "bytes" | "exists")
        {
            return Ok(None);
        }
        let receiver = primitives::primitive_source(member.expression());
        if !self.bun_file_origin(receiver, &mut HashSet::new()) {
            return Ok(None);
        }
        let path = self.expression(receiver)?;
        let path = self.coerce(path, Type::String, receiver)?;
        self.ensure_exception_classes(node)?;
        let (operation, result) = match member.name().text().as_ref() {
            "bytes" => ("bun.fileBytes", Type::bytes()),
            "exists" => ("bun.fileExists", Type::Bool),
            "text" => ("bun.fileText", Type::String),
            _ => unreachable!(),
        };
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args: vec![path],
            r#type: Type::Promise {
                inner: Box::new(result),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn bun_file_property(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression || node.name().text() != "size" {
            return Ok(None);
        }
        let receiver = primitives::primitive_source(node.expression());
        if !self.bun_file_origin(receiver, &mut HashSet::new()) {
            return Ok(None);
        }
        let path = self.expression(receiver)?;
        let path = self.coerce(path, Type::String, receiver)?;
        Ok(Some(Expr::LibCall {
            r#fn: "bun.fileSize".into(),
            args: vec![path],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    fn bun_file_origin(&mut self, node: Node, active: &mut HashSet<u32>) -> bool {
        let node = primitives::primitive_source(node);
        let checked = self.checker.get_type_at_location(node);
        if self.bun_file_type(checked) {
            return true;
        }
        if node.kind() == SyntaxKind::CallExpression {
            let callee = primitives::primitive_source(node.expression());
            return callee.kind() == SyntaxKind::PropertyAccessExpression
                && callee.name().text() == "file"
                && self.native_namespace(callee.expression()) == Some("Bun");
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !active.insert(symbol) {
            return false;
        }
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        let result = !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && declaration.parent().flags().intersects(NodeFlags::CONST)
            && !declaration.initializer().is_nil()
            && self.bun_file_origin(declaration.initializer(), active);
        active.remove(&symbol);
        result
    }

    pub(super) fn bun_spawn_sync(&mut self, node: Node) -> Result<Expr, String> {
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&args.len())
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Bun.spawnSync requires argv and optional literal stdio options",
            ));
        }
        let argv = self.expected_expression(
            args[0],
            Type::Array {
                elem: Box::new(Type::String),
            },
        )?;
        // Bun modes: 0 = ignore, 1 = inherit, 2 = pipe. The backend adapter
        // translates these to the shared child_process runtime convention.
        let mut modes = [0.0, 2.0, 2.0];
        if let Some(options) = args.get(1) {
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(*options, "Bun.spawnSync requires literal stdio options"));
            }
            for property in options.properties() {
                if property.kind() != SyntaxKind::PropertyAssignment
                    || !matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    )
                    || property.initializer().kind() != SyntaxKind::StringLiteral
                {
                    return Err(self.refuse(
                        property,
                        "Bun.spawnSync supports only literal stdio properties",
                    ));
                }
                let slot = match property.name().text() {
                    "stdin" => 0,
                    "stdout" => 1,
                    "stderr" => 2,
                    _ => return Err(self.refuse(property, "Bun.spawnSync option is not ported")),
                };
                modes[slot] = match property.initializer().text() {
                    "ignore" => 0.0,
                    "inherit" => 1.0,
                    "pipe" if slot != 0 => 2.0,
                    _ => {
                        return Err(self.refuse(property, "Bun.spawnSync stdio mode is not ported"));
                    }
                };
            }
        }
        self.ensure_exception_classes(node)?;
        let loc = self.loc(node);
        let mut values = vec![argv];
        values.extend(modes.into_iter().map(|value| Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        }));
        Ok(Expr::LibCall {
            r#fn: "bun.spawnSync".into(),
            args: values,
            r#type: Type::Dyn,
            loc,
        })
    }

    pub(super) fn bun_write(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 2
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "native Bun.write requires a string destination and string payload",
            ));
        }
        let path = self.expected_expression(arguments[0], Type::String)?;
        let byte_payload = matches!(self.ty(arguments[1]), Ok(Type::Bytes { .. }));
        let data = self.expected_expression(
            arguments[1],
            if byte_payload {
                Type::bytes()
            } else {
                Type::String
            },
        )?;
        self.ensure_exception_classes(node)?;
        Ok(Expr::LibCall {
            r#fn: if byte_payload {
                "bun.writeBytes"
            } else {
                "bun.writeText"
            }
            .into(),
            args: vec![path, data],
            r#type: Type::Promise {
                inner: Box::new(Type::F64),
            },
            loc: self.loc(node),
        })
    }

    pub(super) fn bun_child_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = member.expression();
        if matches!(member.name().text(), "write" | "end")
            && receiver.kind() == SyntaxKind::PropertyAccessExpression
            && receiver.name().text() == "stdin"
            && self.bun_spawn_origin(receiver.expression(), &mut HashSet::new())
        {
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            let child = self.expression(receiver.expression())?;
            self.ensure_exception_classes(node)?;
            return match member.name().text() {
                "write" if args.len() == 1 && args[0].kind() != SyntaxKind::SpreadElement => {
                    let data = self.expression(args[0])?;
                    let data = self.coerce(data, Type::Dyn, args[0])?;
                    Ok(Some(Expr::LibCall {
                        r#fn: "bun.stdinWrite".into(),
                        args: vec![child, data],
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }))
                }
                "end" if args.is_empty() => Ok(Some(Expr::LibCall {
                    r#fn: "bun.stdinEnd".into(),
                    args: vec![child],
                    r#type: Type::Void,
                    loc: self.loc(node),
                })),
                "write" => Err(self.refuse(
                    node,
                    "Bun subprocess stdin.write requires one string or Uint8Array payload",
                )),
                _ => Err(self.refuse(node, "Bun subprocess stdin.end requires zero arguments")),
            };
        }
        if member.name().text() == "unref" && matches!(self.ty(receiver), Ok(Type::Child)) {
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if !args.is_empty() {
                return Err(self.refuse(node, "Bun subprocess unref requires zero arguments"));
            }
            let child = self.expression(receiver)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "child.unref".into(),
                args: vec![child],
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        if member.name().text() != "kill" {
            return Ok(None);
        }
        if !matches!(self.ty(receiver), Ok(Type::Child)) {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 1
            || args
                .first()
                .is_some_and(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Bun subprocess kill requires zero or one named signal",
            ));
        }
        let child = self.expression(receiver)?;
        let signal = if let Some(signal) = args.first() {
            self.expected_expression(*signal, Type::String)?
        } else {
            Expr::StrLit {
                value: "SIGTERM".into(),
                r#type: Type::String,
                loc: self.loc(node),
            }
        };
        self.ensure_exception_classes(node)?;
        Ok(Some(Expr::LibCall {
            r#fn: "child.kill".into(),
            args: vec![child, signal],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }

    pub(super) fn bun_which(&mut self, node: Node) -> Result<Expr, String> {
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&args.len())
            || args
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "native Bun.which requires a command and optional PATH/cwd options",
            ));
        }
        let command = self.expected_expression(args[0], Type::String)?;
        let loc = self.loc(node);
        let mut path = Expr::UnitLit {
            unit: "null",
            r#type: Type::Null,
            loc: loc.clone(),
        };
        let mut cwd = Expr::UnitLit {
            unit: "null",
            r#type: Type::Null,
            loc: loc.clone(),
        };
        if let Some(options) = args.get(1) {
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(
                    *options,
                    "native Bun.which options currently require a literal PATH/cwd object",
                ));
            }
            for property in options.properties() {
                if property.kind() != SyntaxKind::PropertyAssignment
                    || !matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    )
                {
                    return Err(self.refuse(
                        property,
                        "native Bun.which requires named PATH/cwd option properties",
                    ));
                }
                let value = self.expected_expression(property.initializer(), Type::String)?;
                match property.name().text() {
                    "PATH" => path = value,
                    "cwd" => cwd = value,
                    _ => return Err(self.refuse(property, "Bun.which option is not ported")),
                }
            }
        }
        let result = self
            .intern_union(vec![Type::String, Type::Null])
            .ok_or_else(|| self.refuse(node, "Bun.which result union is recursive"))?;
        self.ensure_exception_classes(node)?;
        Ok(Expr::LibCall {
            r#fn: "bun.which".into(),
            args: vec![command, path, cwd],
            r#type: result,
            loc,
        })
    }

    pub(super) fn bun_builtin_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.name().text() != "which"
            || self.native_namespace(node.expression()) != Some("Bun")
        {
            return Ok(None);
        }

        // Bun.which is also an ordinary function value. The common injected
        // dependency contract only exposes its command parameter, so retain a
        // fixed one-slot ABI here instead of leaking Bun's optional options
        // object into every callback view. Direct calls keep the wider
        // Bun.which lowering above.
        let result = self
            .intern_union(vec![Type::String, Type::Null])
            .ok_or_else(|| self.refuse(node, "Bun.which result union is recursive"))?;
        self.ensure_exception_classes(node)?;
        let mut helper = helpers::Helper::new(
            "bun_which_value",
            vec![Type::String],
            result.clone(),
            self.loc(node),
        );
        let loc = helper.loc();
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::LibCall {
                r#fn: "bun.which".into(),
                args: vec![
                    helper.read(&helper.param(0)),
                    Expr::UnitLit {
                        unit: "null",
                        r#type: Type::Null,
                        loc: loc.clone(),
                    },
                    Expr::UnitLit {
                        unit: "null",
                        r#type: Type::Null,
                        loc: loc.clone(),
                    },
                ],
                r#type: result.clone(),
                loc: loc.clone(),
            }),
            loc,
        });
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: Type::Func {
                params: vec![Type::String],
                ret: Box::new(result),
                rest: false,
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn bun_response_text(&mut self, call: Node) -> Result<Option<Expr>, String> {
        let method = primitives::primitive_source(call.expression());
        if method.kind() != SyntaxKind::PropertyAccessExpression
            || method.name().text() != "text"
            || !method.question_dot_token().is_nil()
            || !call.arguments().is_empty()
        {
            return Ok(None);
        }
        let receiver = primitives::primitive_source(method.expression());
        if receiver.kind() == SyntaxKind::CallExpression {
            let factory = primitives::primitive_source(receiver.expression());
            if factory.kind() == SyntaxKind::PropertyAccessExpression
                && factory.name().text() == "file"
                && self.native_namespace(factory.expression()) == Some("Bun")
            {
                let arguments = receiver.arguments().into_iter().collect::<Vec<_>>();
                if arguments.len() != 1 || arguments[0].kind() == SyntaxKind::SpreadElement {
                    return Err(self.refuse(
                        receiver,
                        "Bun.file(path).text() requires one represented string path",
                    ));
                }
                let path = self.expected_expression(arguments[0], Type::String)?;
                self.ensure_exception_classes(call)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: "bun.fileText".into(),
                    args: vec![path],
                    r#type: Type::Promise {
                        inner: Box::new(Type::String),
                    },
                    loc: self.loc(call),
                }));
            }
        }
        let constructor = primitives::primitive_source(method.expression());
        if constructor.kind() != SyntaxKind::NewExpression {
            return Ok(None);
        }
        let name = constructor.expression();
        if name.kind() != SyntaxKind::Identifier || name.text() != "Response" {
            return Ok(None);
        }
        let symbol = self.checker.get_symbol_at_location(name, false);
        if symbol.0 == 0
            || !self
                .checker
                .sym(symbol)
                .declarations
                .iter()
                .any(|declaration| {
                    if declaration.is_nil() {
                        return false;
                    }
                    let file = source_file_info(source_frontend::prelude::get_source_file_of_node(
                        *declaration,
                    ));
                    let path = &file.file_name;
                    path.ends_with("/lib.dom.d.ts")
                        || path.contains("/node_modules/@types/node/web-globals/fetch.d.ts")
                })
        {
            return Ok(None);
        }
        let args = constructor.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 1 {
            return Ok(None);
        }
        let output = primitives::primitive_source(args[0]);
        if output.kind() != SyntaxKind::PropertyAccessExpression
            || !output.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let stderr = match output.name().text() {
            "stdout" => false,
            "stderr" => true,
            _ => return Ok(None),
        };
        if !self.bun_spawn_origin(output.expression(), &mut HashSet::new()) {
            return Ok(None);
        }
        let child = self.expression(output.expression())?;
        self.ensure_exception_classes(call)?;
        let loc = self.loc(call);
        Ok(Some(Expr::LibCall {
            r#fn: "bun.responseText".into(),
            args: vec![
                child,
                Expr::BoolLit {
                    value: stderr,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
            ],
            r#type: Type::Promise {
                inner: Box::new(Type::String),
            },
            loc,
        }))
    }
    pub(super) fn bun_spawn_origin(&mut self, node: Node, active: &mut HashSet<u32>) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() == SyntaxKind::CallExpression {
            let callee = node.expression();
            return callee.kind() == SyntaxKind::PropertyAccessExpression
                && callee.name().text() == "spawn"
                && self.native_namespace(callee.expression()) == Some("Bun");
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !active.insert(symbol) {
            return false;
        }
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        let result = !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && declaration.parent().flags().intersects(NodeFlags::CONST)
            && !declaration.initializer().is_nil()
            && self.bun_spawn_origin(declaration.initializer(), active);
        active.remove(&symbol);
        result
    }
    pub(super) fn bun_spawn(&mut self, node: Node) -> Result<Expr, String> {
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&args.len())
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Bun.spawn requires argv and optional literal stdio options",
            ));
        }
        let argv = self.expected_expression(
            args[0],
            Type::Array {
                elem: Box::new(Type::String),
            },
        )?;
        let loc = self.loc(node);
        let number = |value| Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let mut modes = [number(0.0), number(2.0), number(1.0)];
        let mut detached = Expr::BoolLit {
            value: false,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let mut cwd = Expr::StrLit {
            value: String::new(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let mut environment = None;
        let mut environment_presence_is_dynamic = false;
        let mut timeout = None;
        let mut prefix = Vec::new();
        if let Some(options) = args.get(1) {
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(*options, "Bun.spawn requires literal stdio options"));
            }
            for property in options.properties() {
                if property.kind() == SyntaxKind::SpreadAssignment {
                    let spread = self.expression(property.expression())?;
                    let represented = spread.ty();
                    let mut fields = Vec::new();
                    let mut collect_record = |shape_id: usize| {
                        let record = &self.records[shape_id];
                        if record.tuple
                            || self.callables.contains_key(&shape_id)
                            || self.enum_shape(shape_id)
                        {
                            return false;
                        }
                        for field in &record.fields {
                            if !fields.contains(&field.name) {
                                fields.push(field.name.clone());
                            }
                        }
                        true
                    };
                    let represented_data = match &represented {
                        Type::Record { shape_id } => collect_record(*shape_id),
                        Type::Union { union_id } => self.unions[*union_id]
                            .arms
                            .clone()
                            .into_iter()
                            .all(|arm| match arm {
                                Type::Record { shape_id } => collect_record(shape_id),
                                // Object spread ignores nullish values. Retain
                                // that behavior when flow planning keeps an
                                // optional record as a tagged native union.
                                Type::Null | Type::Undefined => true,
                                _ => false,
                            }),
                        _ => false,
                    };
                    if !represented_data {
                        return Err(self.refuse(
                            property,
                            &format!(
                                "Bun.spawn option spreads require represented data records, got {represented:?}"
                            ),
                        ));
                    }
                    if fields
                        .iter()
                        .any(|field| !matches!(field.as_str(), "cwd" | "env"))
                    {
                        return Err(self.refuse(
                            property,
                            "Bun.spawn option spreads currently support only cwd and env",
                        ));
                    }
                    let spread = self.coerce(spread, Type::Dyn, property.expression())?;
                    let spread_local = Local {
                        id: format!("bun_spawn_options{}", self.locals.len()),
                        name: "Bun.spawn spread options".into(),
                        r#type: Type::Dyn,
                        mutable: false,
                        boxed: false,
                    };
                    self.locals.push(spread_local.clone());
                    prefix.push(Stmt::VarDecl {
                        local_id: spread_local.id.clone(),
                        init: spread,
                        loc: self.loc(property),
                    });
                    let read_spread = || Expr::VarRef {
                        local_id: spread_local.id.clone(),
                        r#type: Type::Dyn,
                        loc: self.loc(property),
                    };
                    if fields.iter().any(|field| field == "cwd") {
                        cwd = Expr::LibCall {
                            r#fn: "bun.spawnOptionsCwd".into(),
                            args: vec![read_spread(), cwd],
                            r#type: Type::String,
                            loc: self.loc(property),
                        };
                    }
                    if fields.iter().any(|field| field == "env") {
                        let fallback = environment.take().unwrap_or_else(|| Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(property),
                        });
                        let fallback = self.coerce(fallback, Type::Dyn, property)?;
                        let value = Expr::LibCall {
                            r#fn: "bun.spawnOptionsEnv".into(),
                            args: vec![read_spread(), fallback],
                            r#type: Type::Dyn,
                            loc: self.loc(property),
                        };
                        let env_local = Local {
                            id: format!("bun_spawn_env{}", self.locals.len()),
                            name: "Bun.spawn spread environment".into(),
                            r#type: Type::Dyn,
                            mutable: false,
                            boxed: false,
                        };
                        self.locals.push(env_local.clone());
                        prefix.push(Stmt::VarDecl {
                            local_id: env_local.id.clone(),
                            init: value,
                            loc: self.loc(property),
                        });
                        environment = Some(Expr::VarRef {
                            local_id: env_local.id,
                            r#type: Type::Dyn,
                            loc: self.loc(property),
                        });
                        environment_presence_is_dynamic = true;
                    }
                    continue;
                }
                if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                    match property.name().text() {
                        "env" => {
                            environment =
                                Some(self.expected_expression(property.name(), Type::Dyn)?);
                            environment_presence_is_dynamic = false;
                        }
                        "cwd" => {
                            cwd = self.expected_expression(property.name(), Type::String)?;
                        }
                        _ => {
                            return Err(
                                self.refuse(property, "Bun.spawn shorthand option is not ported")
                            );
                        }
                    }
                    continue;
                }
                if property.kind() != SyntaxKind::PropertyAssignment
                    || !matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    )
                {
                    return Err(self.refuse(property, "Bun.spawn requires named option properties"));
                }
                if property.name().text() == "env" {
                    environment =
                        Some(self.expected_expression(property.initializer(), Type::Dyn)?);
                    environment_presence_is_dynamic = false;
                    continue;
                }
                if property.name().text() == "cwd" {
                    cwd = self.expected_expression(property.initializer(), Type::String)?;
                    continue;
                }
                if property.name().text() == "detached" {
                    detached = self.expected_expression(property.initializer(), Type::Bool)?;
                    continue;
                }
                if property.name().text() == "timeout" {
                    timeout = Some(self.expected_expression(property.initializer(), Type::F64)?);
                    continue;
                }
                let slot = match property.name().text() {
                    "stdin" => 0,
                    "stdout" => 1,
                    "stderr" => 2,
                    _ => return Err(self.refuse(property, "Bun.spawn option is not ported")),
                };
                modes[slot] = match property.initializer().kind() {
                    SyntaxKind::StringLiteral => match property.initializer().text() {
                        "ignore" => number(0.0),
                        "inherit" => number(1.0),
                        "pipe" => number(2.0),
                        _ => {
                            return Err(self.refuse(property, "Bun.spawn stdio mode is not ported"));
                        }
                    },
                    _ => Expr::LibCall {
                        r#fn: "bun.stdioMode".into(),
                        args: vec![self.expected_expression(property.initializer(), Type::String)?],
                        r#type: Type::F64,
                        loc: self.loc(property),
                    },
                };
            }
        }
        self.ensure_exception_classes(node)?;
        let mut values = vec![argv];
        values.extend(modes);
        values.push(detached);
        values.push(if environment_presence_is_dynamic {
            Expr::LibCall {
                r#fn: "bun.envPresent".into(),
                args: vec![environment.clone().expect("dynamic environment value")],
                r#type: Type::Bool,
                loc: loc.clone(),
            }
        } else {
            Expr::BoolLit {
                value: environment.is_some(),
                r#type: Type::Bool,
                loc: loc.clone(),
            }
        });
        values.push(if let Some(environment) = environment {
            Expr::LibCall {
                r#fn: "bun.envPairs".into(),
                args: vec![environment],
                r#type: Type::Array {
                    elem: Box::new(Type::String),
                },
                loc: loc.clone(),
            }
        } else {
            Expr::ArrayLit {
                elems: vec![],
                r#type: Type::Array {
                    elem: Box::new(Type::String),
                },
                loc: loc.clone(),
            }
        });
        values.push(cwd);
        let call = Expr::LibCall {
            r#fn: "bun.spawn".into(),
            args: values,
            r#type: Type::Child,
            loc: loc.clone(),
        };
        let call = if let Some(timeout) = timeout {
            Expr::LibCall {
                r#fn: "bun.spawnTimeout".into(),
                args: vec![call, timeout],
                r#type: Type::Child,
                loc,
            }
        } else {
            call
        };
        if prefix.is_empty() {
            Ok(call)
        } else {
            Ok(Expr::Sequence {
                stmts: prefix,
                result: Box::new(call),
                r#type: Type::Child,
                loc: self.loc(node),
            })
        }
    }
}
