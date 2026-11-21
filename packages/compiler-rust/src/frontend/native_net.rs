use super::*;

impl Lowerer<'_> {
    fn tls_certificate_array_test(&mut self, call: Node, attribute: Node) -> bool {
        let call = primitives::primitive_source(call);
        if call.kind() != SyntaxKind::CallExpression || call.arguments().len() != 1 {
            return false;
        }
        let callee = primitives::primitive_source(call.expression());
        let argument = primitives::primitive_source(call.arguments().get(0));
        let callee_symbol = if callee.kind() == SyntaxKind::PropertyAccessExpression {
            self.symbol(callee.name())
        } else {
            0
        };
        if callee.kind() != SyntaxKind::PropertyAccessExpression
            || callee.name().text() != "isArray"
            || !self.primitive_symbol(callee_symbol, "isArray", Some("ArrayConstructor"))
            || argument.kind() != SyntaxKind::PropertyAccessExpression
            || argument.name().text() != attribute.name().text()
        {
            return false;
        }
        let argument_owner = argument.expression();
        let attribute_owner = attribute.expression();
        argument_owner.kind() == SyntaxKind::PropertyAccessExpression
            && attribute_owner.kind() == SyntaxKind::PropertyAccessExpression
            && argument_owner.name().text() == attribute_owner.name().text()
            && self.symbol(argument_owner.expression()) == self.symbol(attribute_owner.expression())
    }

    pub(super) fn tls_peer_certificate_call(&mut self, node: Node) -> bool {
        if node.is_nil() || node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = node.expression();
        member.kind() == SyntaxKind::PropertyAccessExpression
            && member.name().text() == "getPeerCertificate"
            && self.net_socket_type(member.expression())
    }

    pub(super) fn validate_tls_peer_certificate_call(&mut self, node: Node) -> Result<(), String> {
        if !self.tls_peer_certificate_call(node) {
            return Ok(());
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if !args.is_empty() && !(args.len() == 1 && args[0].kind() == SyntaxKind::FalseKeyword) {
            return Err(self.refuse(node, "detailed TLS peer certificate chains are not ported"));
        }
        let declaration = node.parent();
        if declaration.kind() != SyntaxKind::VariableDeclaration
            || declaration.initializer() != node
            || declaration.name().kind() != SyntaxKind::Identifier
        {
            return Err(self.refuse(
                node,
                "TLS peer certificate needs a local field-only binding",
            ));
        }
        let mut enclosing = declaration;
        while !enclosing.is_nil()
            && !matches!(
                enclosing.kind(),
                SyntaxKind::ArrowFunction
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::FunctionDeclaration
                    | SyntaxKind::MethodDeclaration
            )
        {
            enclosing = enclosing.parent();
        }
        if enclosing.is_nil() {
            return Err(self.refuse(
                node,
                "TLS peer certificate currently needs a secure-connect callback",
            ));
        }
        let parent = enclosing.parent();
        let secure_callback = matches!(
            enclosing.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) && parent.kind() == SyntaxKind::CallExpression
            && parent
                .arguments()
                .into_iter()
                .any(|argument| argument == enclosing)
            && {
                let callee = parent.expression();
                if callee.kind() == SyntaxKind::PropertyAccessExpression
                    && callee.name().text() == "connect"
                {
                    self.native_namespace(callee.expression()) == Some("tls")
                } else if callee.kind() == SyntaxKind::Identifier {
                    let symbol = self.native_symbol(callee);
                    self.native_functions
                        .get(&symbol)
                        .is_some_and(|(module, member)| *module == "tls" && member == "connect")
                } else {
                    false
                }
            };
        if !secure_callback {
            return Err(self.refuse(
                node,
                "TLS peer certificate currently needs a secure-connect callback",
            ));
        }
        let name = declaration.name();
        let symbol = self.symbol(name);
        let scope = declaration.parent().parent().parent();
        if symbol == 0 || scope.kind() != SyntaxKind::Block {
            return Err(self.refuse(node, "TLS peer certificate scope is not represented"));
        }
        let mut pending = vec![scope];
        while let Some(current) = pending.pop() {
            if current.kind() == SyntaxKind::Identifier
                && current != name
                && self.symbol(current) == symbol
            {
                let property = current.parent();
                if property.kind() != SyntaxKind::PropertyAccessExpression
                    || property.expression() != current
                {
                    return Err(self.refuse(
                        current,
                        "TLS peer certificate values need a complete descriptor",
                    ));
                }
                let field = property.name().text();
                if matches!(field, "subject" | "issuer") {
                    let attribute = property.parent();
                    if attribute.kind() != SyntaxKind::PropertyAccessExpression
                        || attribute.expression() != property
                        || !matches!(
                            attribute.name().text(),
                            "CN" | "C"
                                | "L"
                                | "ST"
                                | "O"
                                | "OU"
                                | "serialNumber"
                                | "SN"
                                | "GN"
                                | "DC"
                                | "UID"
                                | "emailAddress"
                        )
                    {
                        return Err(self.refuse(
                            property,
                            "TLS certificate name objects need a complete descriptor",
                        ));
                    }
                    let consumer = attribute.parent();
                    let safe = (consumer.kind() == SyntaxKind::ElementAccessExpression
                        && consumer.expression() == attribute)
                        || (consumer.kind() == SyntaxKind::CallExpression
                            && self.tls_certificate_array_test(consumer, attribute))
                        || (consumer.kind() == SyntaxKind::ConditionalExpression
                            && (consumer.when_true() == attribute
                                || consumer.when_false() == attribute)
                            && self.tls_certificate_array_test(consumer.condition(), attribute));
                    if !safe {
                        return Err(self.refuse(
                            attribute,
                            "TLS certificate name values require an array guard",
                        ));
                    }
                } else if !matches!(
                    field,
                    "valid_from"
                        | "valid_to"
                        | "fingerprint"
                        | "fingerprint256"
                        | "fingerprint512"
                        | "serialNumber"
                        | "ca"
                ) {
                    return Err(self.refuse(property, "TLS peer certificate field is not ported"));
                }
                let mut target = property;
                if matches!(field, "subject" | "issuer") {
                    target = property.parent();
                }
                let consumer = target.parent();
                if consumer.kind() == SyntaxKind::BinaryExpression
                    && consumer.left() == target
                    && (consumer.operator_token().kind() == SyntaxKind::EqualsToken
                        || updates::compound_operator(consumer.operator_token().kind()).is_some()
                        || matches!(
                            consumer.operator_token().kind(),
                            SyntaxKind::QuestionQuestionEqualsToken
                                | SyntaxKind::BarBarEqualsToken
                                | SyntaxKind::AmpersandAmpersandEqualsToken
                        ))
                    || matches!(
                        consumer.kind(),
                        SyntaxKind::DeleteExpression
                            | SyntaxKind::PrefixUnaryExpression
                            | SyntaxKind::PostfixUnaryExpression
                    )
                {
                    return Err(self.refuse(target, "TLS peer certificate mutation is not ported"));
                }
            }
            current.for_each_child(&mut |child| {
                pending.push(child);
                false
            });
        }
        Ok(())
    }

    pub(super) fn net_socket_type(&mut self, node: Node) -> bool {
        let id = self.checker.get_type_at_location(node);
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0
            || !matches!(
                self.checker.sym(symbol).name.as_ref(),
                "Socket" | "TLSSocket"
            )
        {
            return false;
        }
        self.checker
            .sym(symbol)
            .declarations
            .iter()
            .any(|declaration| {
                if declaration.is_nil() {
                    return false;
                }
                let file = source_file_info(get_source_file_of_node(*declaration));
                file.file_name
                    .replace('\\', "/")
                    .contains("/@types/node/net.d.ts")
                    || file
                        .file_name
                        .replace('\\', "/")
                        .contains("/@types/node/tls.d.ts")
                    || {
                        let mut current = *declaration;
                        while !current.is_nil() && current.kind() != SyntaxKind::SourceFile {
                            if current.kind() == SyntaxKind::ModuleDeclaration
                                && matches!(
                                    current.name().text(),
                                    "node:net" | "net" | "node:tls" | "tls"
                                )
                            {
                                return true;
                            }
                            current = current.parent();
                        }
                        false
                    }
            })
    }

    pub(super) fn tls_connect(&mut self, node: Node) -> Result<Expr, String> {
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&args.len())
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "tls.connect needs an options object and optional callback",
            ));
        }
        let options = primitives::primitive_source(args[0]);
        if options.kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(
                args[0],
                "tls.connect options require a closed object literal",
            ));
        }
        let mut fields = std::collections::HashSet::new();
        for property in options.properties() {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
            ) || !matches!(
                property.name().kind(),
                SyntaxKind::Identifier | SyntaxKind::StringLiteral
            ) {
                return Err(self.refuse(
                    property,
                    "tls.connect options need ordinary named data properties",
                ));
            }
            let name = property.name().text().to_string();
            if !matches!(
                name.as_str(),
                "host" | "port" | "servername" | "rejectUnauthorized" | "ca"
            ) || !fields.insert(name)
            {
                return Err(self.refuse(property, "tls.connect option is unsupported or repeated"));
            }
        }
        if !["host", "port", "servername"]
            .iter()
            .all(|name| fields.contains(*name))
        {
            return Err(self.refuse(
                options,
                "tls.connect currently requires host, port and servername",
            ));
        }
        self.ensure_exception_classes(node)?;
        let options_value = self.expected_expression(args[0], Type::Dyn)?;
        let callback = if let Some(callback) = args.get(1) {
            self.expected_expression(*callback, Type::Dyn)?
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
        Ok(Expr::LibCall {
            r#fn: "tls.connectOptions".into(),
            args: vec![options_value, callback],
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }

    pub(super) fn net_socket_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let constructor = receivers::reference_node(node.expression());
        let socket = if constructor.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(constructor);
            self.native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "net" && member == "Socket")
        } else {
            constructor.kind() == SyntaxKind::PropertyAccessExpression
                && constructor.name().text() == "Socket"
                && self.native_namespace(constructor.expression()) == Some("net")
        };
        if !socket {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "native net.Socket constructor options are not ported"));
        }
        self.ensure_exception_classes(node)?;
        Ok(Some(Expr::LibCall {
            r#fn: "net.socketNew".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
}
