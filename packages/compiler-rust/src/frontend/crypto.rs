use super::*;

impl Lowerer<'_> {
    pub(super) fn crypto_sign_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.name.as_ref() == "Sign"
            && symbol.declarations.iter().any(|declaration| {
                !declaration.is_nil()
                    && source_file_info(source_frontend::prelude::get_source_file_of_node(
                        *declaration,
                    ))
                    .file_name
                    .replace('\\', "/")
                    .ends_with("/@types/node/crypto.d.ts")
            })
    }

    pub(super) fn crypto_sign_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let callee = receivers::reference_node(node.expression());
        let sign = if callee.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(callee);
            self.native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "crypto" && member == "createSign")
        } else {
            callee.kind() == SyntaxKind::PropertyAccessExpression
                && callee.name().text() == "createSign"
                && self.native_namespace(callee.expression()) == Some("crypto")
        };
        if !sign {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "createSign requires one native algorithm argument"));
        }
        let algorithm = self.expected_expression(args[0], Type::String)?;
        self.ensure_exception_classes(node)?;
        Ok(Some(Expr::LibCall {
            r#fn: "crypto.signNew".into(),
            args: vec![algorithm],
            r#type: Type::CryptoSign,
            loc: self.loc(node),
        }))
    }

    pub(super) fn crypto_sign_handle_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || self.ty(member.expression()).ok() != Some(Type::CryptoSign)
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "native Sign methods do not accept spread arguments"));
        }
        let sign = self.expected_expression(member.expression(), Type::CryptoSign)?;
        match member.name().text().as_ref() {
            "update" if args.len() == 1 => {
                let bytes = matches!(self.ty(args[0]), Ok(Type::Bytes { .. }));
                let data = self.expected_expression(
                    args[0],
                    if bytes { Type::bytes() } else { Type::String },
                )?;
                Ok(Some(Expr::LibCall {
                    r#fn: if bytes {
                        "crypto.signUpdateBytes"
                    } else {
                        "crypto.signUpdateString"
                    }
                    .into(),
                    args: vec![sign, data],
                    r#type: Type::CryptoSign,
                    loc: self.loc(node),
                }))
            }
            "sign" if (1..=2).contains(&args.len()) => {
                let key = self.expected_call_argument(args[0], Type::Dyn, true)?;
                let mut values = vec![sign, key];
                let (operation, result) = if args.len() == 2 {
                    values.push(self.expected_expression(args[1], Type::String)?);
                    ("crypto.signFinalString", Type::String)
                } else {
                    ("crypto.signFinalBytes", Type::bytes())
                };
                Ok(Some(Expr::LibCall {
                    r#fn: operation.into(),
                    args: values,
                    r#type: result,
                    loc: self.loc(node),
                }))
            }
            _ => Err(self.refuse(node, "native Sign method or argument shape is not ported")),
        }
    }

    pub(super) fn bun_crypto_hasher_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.declarations.iter().any(|declaration| {
            !declaration.is_nil() && {
                let path = &source_file_info(source_frontend::prelude::get_source_file_of_node(
                    *declaration,
                ))
                .file_name;
                (symbol.name.as_ref() == "CryptoHasher" && path.contains("/bun-types/"))
                    || (symbol.name.as_ref() == "Hash"
                        && path.contains("/@types/node/")
                        && path.ends_with("/crypto.d.ts"))
            }
        })
    }

    pub(super) fn crypto_hash_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let bun = self.is_bun_crypto_hasher_new(node);
        let node_hash = node.kind() == SyntaxKind::CallExpression
            && self.is_create_hash_call(receivers::reference_node(node.expression()));
        if !bun && !node_hash {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !matches!(arguments.as_slice(), [argument] if argument.kind() != SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Bun.CryptoHasher requires one native algorithm argument",
            ));
        }
        let algorithm = self.expected_expression(arguments[0], Type::String)?;
        Ok(Some(Expr::LibCall {
            r#fn: "crypto.hashNew".into(),
            args: vec![algorithm],
            r#type: Type::CryptoHash,
            loc: self.loc(node),
        }))
    }

    pub(super) fn crypto_hash_handle_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || self.ty(member.expression()).ok() != Some(Type::CryptoHash)
        {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !matches!(arguments.as_slice(), [argument] if argument.kind() != SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "native hash methods require exactly one argument"));
        }
        let hash = self.expected_expression(member.expression(), Type::CryptoHash)?;
        match member.name().text().as_ref() {
            "update" => {
                let bytes = matches!(self.ty(arguments[0]), Ok(Type::Bytes { .. }));
                let data = self.expected_expression(
                    arguments[0],
                    if bytes { Type::bytes() } else { Type::String },
                )?;
                Ok(Some(Expr::LibCall {
                    r#fn: if bytes {
                        "crypto.hashUpdateBytes"
                    } else {
                        "crypto.hashUpdateString"
                    }
                    .into(),
                    args: vec![hash, data],
                    r#type: Type::CryptoHash,
                    loc: self.loc(node),
                }))
            }
            "digest" => {
                let encoding = self.expected_expression(arguments[0], Type::String)?;
                Ok(Some(Expr::LibCall {
                    r#fn: "crypto.hashDigest".into(),
                    args: vec![hash, encoding],
                    r#type: Type::String,
                    loc: self.loc(node),
                }))
            }
            _ => Ok(None),
        }
    }

    fn is_create_private_key_call(&mut self, node: Node) -> bool {
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| {
                    *module == "crypto" && member == "createPrivateKey"
                });
        }
        node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "createPrivateKey"
            && self.native_namespace(node.expression()) == Some("crypto")
    }

    pub(super) fn crypto_private_key_export_chain(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let export = receivers::reference_node(node.expression());
        if export.kind() != SyntaxKind::PropertyAccessExpression || export.name().text() != "export"
        {
            return Ok(None);
        }
        let create = receivers::reference_node(export.expression());
        if create.kind() != SyntaxKind::CallExpression
            || !self.is_create_private_key_call(receivers::reference_node(create.expression()))
        {
            return Ok(None);
        }
        let create_args = create.arguments().into_iter().collect::<Vec<_>>();
        let export_args = node.arguments().into_iter().collect::<Vec<_>>();
        if create_args.len() != 1
            || export_args.len() != 1
            || create_args[0].kind() == SyntaxKind::SpreadElement
            || export_args[0].kind() == SyntaxKind::SpreadElement
        {
            return Err(self.refuse(
                node,
                "native createPrivateKey export requires one key and one options object",
            ));
        }
        let options = receivers::reference_node(export_args[0]);
        if options.kind() != SyntaxKind::ObjectLiteralExpression || options.properties().len() != 2
        {
            return Err(self.refuse(
                options,
                "native private-key export requires literal pkcs8/pem options",
            ));
        }
        let mut key_type = false;
        let mut format = false;
        for property in options.properties() {
            if property.kind() != SyntaxKind::PropertyAssignment {
                return Err(self.refuse(
                    property,
                    "native private-key export options require plain data properties",
                ));
            }
            let value = receivers::reference_node(property.initializer());
            match self.data_property_name(property.name()).as_deref() {
                Some("type")
                    if value.kind() == SyntaxKind::StringLiteral && value.text() == "pkcs8" =>
                {
                    key_type = true;
                }
                Some("format")
                    if value.kind() == SyntaxKind::StringLiteral && value.text() == "pem" =>
                {
                    format = true;
                }
                _ => {
                    return Err(self.refuse(
                        property,
                        "native private-key export supports only type 'pkcs8' and format 'pem'",
                    ));
                }
            }
        }
        if !key_type || !format {
            return Err(self.refuse(
                options,
                "native private-key export requires type 'pkcs8' and format 'pem'",
            ));
        }
        self.ensure_exception_classes(node)?;
        let key = self.expected_expression(create_args[0], Type::String)?;
        Ok(Some(Expr::LibCall {
            r#fn: "crypto.privateKeyPkcs8Pem".into(),
            args: vec![key],
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }

    pub(super) fn standard_crypto_key_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.name.as_ref() == "CryptoKey"
            && symbol.declarations.iter().any(|declaration| {
                let info = source_file_info(source_frontend::prelude::get_source_file_of_node(
                    *declaration,
                ));
                let path = &info.file_name;
                path.ends_with("/lib.dom.d.ts")
                    || path.ends_with("/lib.webworker.d.ts")
                    || path.contains("/@types/node/")
            })
    }

    fn standard_subtle_method(&mut self, member: Node, name: &str) -> bool {
        member.kind() == SyntaxKind::PropertyAccessExpression && member.name().text() == name && {
            let symbol = self.symbol(member.name());
            self.primitive_symbol(symbol, name, Some("SubtleCrypto"))
        }
    }

    pub(super) fn crypto_web_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        let operation = if self.standard_subtle_method(member, "importKey") {
            "importKey"
        } else if self.standard_subtle_method(member, "sign") {
            "sign"
        } else {
            return Ok(None);
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "Web Crypto calls do not accept native spreads"));
        }
        let bytes = Type::bytes();
        match operation {
            "importKey" => {
                if arguments.len() != 5
                    || !matches!(
                        receivers::reference_node(arguments[0]).kind(),
                        SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
                    )
                    || receivers::reference_node(arguments[0]).text() != "pkcs8"
                {
                    return Err(self.refuse(
                        node,
                        "native subtle.importKey requires the PKCS8 five-argument overload",
                    ));
                }
                let mut values = Vec::with_capacity(arguments.len());
                for argument in &arguments {
                    values.push(self.expression(*argument)?);
                }
                values[1] = self.coerce(values[1].clone(), bytes.clone(), arguments[1])?;
                let result = Type::Promise {
                    inner: Box::new(bytes.clone()),
                };
                let mut helper = helpers::Helper::new(
                    "crypto_import_pkcs8",
                    values.iter().map(Expr::ty).collect(),
                    result.clone(),
                    self.loc(node),
                );
                helper.function.body.push(Stmt::Return {
                    value: Some(Expr::Intrinsic {
                        name: "promise.resolve".into(),
                        args: vec![helper.read(&helper.param(1))],
                        r#type: result.clone(),
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                });
                Ok(Some(Expr::Call {
                    callee: self.install_helper(helper.function),
                    args: values,
                    r#type: result,
                    loc: self.loc(node),
                }))
            }
            "sign" => {
                if arguments.len() != 3 {
                    return Err(
                        self.refuse(node, "native subtle.sign requires algorithm, key and data")
                    );
                }
                let algorithm = self.expected_expression(arguments[0], Type::String)?;
                let key = self.expected_expression(arguments[1], bytes.clone())?;
                let data = self.expected_expression(arguments[2], bytes.clone())?;
                let signature = Expr::LibCall {
                    r#fn: "crypto.rsaPkcs1Sha256".into(),
                    args: vec![algorithm, key, data],
                    r#type: bytes.clone(),
                    loc: self.loc(node),
                };
                let result = Type::Promise {
                    inner: Box::new(bytes),
                };
                Ok(Some(Expr::Intrinsic {
                    name: "promise.resolve".into(),
                    args: vec![signature],
                    r#type: result,
                    loc: self.loc(node),
                }))
            }
            _ => unreachable!(),
        }
    }

    fn is_create_hash_call(&mut self, node: Node) -> bool {
        self.is_crypto_member(node, "createHash")
    }

    fn is_crypto_member(&mut self, node: Node, name: &str) -> bool {
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "crypto" && member == name);
        }
        node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == name
            && self.native_namespace(node.expression()) == Some("crypto")
    }

    fn is_bun_crypto_hasher_new(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::NewExpression {
            return false;
        }
        let constructor = primitives::primitive_source(node.expression());
        constructor.kind() == SyntaxKind::PropertyAccessExpression
            && constructor.name().text() == "CryptoHasher"
            && self.bun_namespace_origin(constructor.expression(), &mut HashSet::new())
    }

    fn bun_namespace_origin(&mut self, node: Node, active: &mut HashSet<u32>) -> bool {
        let node = primitives::primitive_source(node);
        if self.native_namespace(node) == Some("Bun") {
            return true;
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
            && self.bun_namespace_origin(declaration.initializer(), active);
        active.remove(&symbol);
        result
    }

    pub(super) fn crypto_hash_chain(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let digest_member = node.expression();
        if digest_member.kind() != SyntaxKind::PropertyAccessExpression
            || digest_member.name().text() != "digest"
        {
            return Ok(None);
        }
        let mut create_call = digest_member.expression();
        let mut update_nodes = Vec::new();
        while create_call.kind() == SyntaxKind::CallExpression {
            let update_member = create_call.expression();
            if update_member.kind() != SyntaxKind::PropertyAccessExpression
                || update_member.name().text() != "update"
            {
                break;
            }
            let update_args = create_call.arguments().into_iter().collect::<Vec<_>>();
            if update_args.len() != 1 || update_args[0].kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(
                    create_call,
                    "native hash update requires one string or byte argument",
                ));
            }
            update_nodes.push(update_args[0]);
            create_call = update_member.expression();
        }
        update_nodes.reverse();
        if create_call.kind() == SyntaxKind::CallExpression
            && self.is_crypto_member(create_call.expression(), "createHmac")
        {
            // createHmac(algorithm, key).update(text).digest(encoding) with a
            // string key and at most one string update.
            let create_args = create_call.arguments().into_iter().collect::<Vec<_>>();
            let digest_args = node.arguments().into_iter().collect::<Vec<_>>();
            if create_args.len() != 2
                || digest_args.len() != 1
                || update_nodes.len() > 1
                || create_args
                    .iter()
                    .chain(&digest_args)
                    .chain(&update_nodes)
                    .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
                || self.ty(create_args[1]).ok() != Some(Type::String)
                || update_nodes
                    .first()
                    .is_some_and(|update| self.ty(*update).ok() != Some(Type::String))
            {
                return Err(self.refuse(
                    node,
                    "native HMAC chain requires an algorithm, a string key, at most one string update and one digest encoding",
                ));
            }
            let algorithm = self.expected_expression(create_args[0], Type::String)?;
            let key = self.expected_expression(create_args[1], Type::String)?;
            let data = match update_nodes.first() {
                Some(update) => self.expected_expression(*update, Type::String)?,
                None => Expr::StrLit {
                    value: String::new(),
                    r#type: Type::String,
                    loc: self.loc(node),
                },
            };
            let encoding = self.expected_expression(digest_args[0], Type::String)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "crypto.hmacStringKey".into(),
                args: vec![algorithm, key, data, encoding],
                r#type: Type::String,
                loc: self.loc(node),
            }));
        }
        let create_hash = create_call.kind() == SyntaxKind::CallExpression
            && self.is_create_hash_call(create_call.expression());
        let bun_hasher = self.is_bun_crypto_hasher_new(create_call);
        if !create_hash && !bun_hasher {
            return Ok(None);
        }

        let create_args = create_call.arguments().into_iter().collect::<Vec<_>>();
        let digest_args = node.arguments().into_iter().collect::<Vec<_>>();
        if create_args.len() != 1
            || digest_args.len() != 1
            || create_args
                .iter()
                .chain(&digest_args)
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "native hash chain requires one algorithm and one digest encoding",
            ));
        }

        let algorithm_node = receivers::reference_node(create_args[0]);
        let encoding_node = receivers::reference_node(digest_args[0]);
        // A literal must name a lowered digest; a computed name (for example
        // a template helper's `algorithm` argument) is validated at runtime
        // with Node's "Digest method not supported".
        let literal_algorithm = matches!(
            algorithm_node.kind(),
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        );
        if (literal_algorithm
            && !matches!(
                algorithm_node.text(),
                "md5" | "sha1" | "sha256" | "sha384" | "sha512"
            ))
            || (!literal_algorithm && self.ty(create_args[0]).ok() != Some(Type::String))
        {
            return Err(self.refuse(
                create_args[0],
                "native hash construction requires a supported literal algorithm",
            ));
        }
        if !matches!(
            encoding_node.kind(),
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
        ) || !matches!(encoding_node.text(), "hex" | "base64")
        {
            return Err(self.refuse(
                digest_args[0],
                "native hash digest requires literal hex or base64 encoding",
            ));
        }

        let algorithm = self.expected_expression(create_args[0], Type::String)?;
        let byte_input = update_nodes
            .first()
            .is_some_and(|update| matches!(self.ty(*update), Ok(Type::Bytes { .. })));
        let (operation, data) = if update_nodes.len() == 1 && byte_input {
            (
                "crypto.hashBytes",
                self.expected_expression(update_nodes[0], Type::bytes())?,
            )
        } else if update_nodes.len() <= 1 {
            let update = update_nodes.first().copied();
            let data = if let Some(update) = update {
                self.expected_expression(update, Type::String)?
            } else {
                Expr::StrLit {
                    value: String::new(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            };
            ("crypto.hashString", data)
        } else {
            if update_nodes
                .iter()
                .any(|update| matches!(self.ty(*update), Ok(Type::Bytes { .. })))
            {
                let mut hash = Expr::LibCall {
                    r#fn: "crypto.hashNew".into(),
                    args: vec![algorithm],
                    r#type: Type::CryptoHash,
                    loc: self.loc(node),
                };
                for update in &update_nodes {
                    let bytes = matches!(self.ty(*update), Ok(Type::Bytes { .. }));
                    let data = self.expected_expression(
                        *update,
                        if bytes { Type::bytes() } else { Type::String },
                    )?;
                    hash = Expr::LibCall {
                        r#fn: if bytes {
                            "crypto.hashUpdateBytes"
                        } else {
                            "crypto.hashUpdateString"
                        }
                        .into(),
                        args: vec![hash, data],
                        r#type: Type::CryptoHash,
                        loc: self.loc(*update),
                    };
                }
                let encoding = self.expected_expression(digest_args[0], Type::String)?;
                return Ok(Some(Expr::LibCall {
                    r#fn: "crypto.hashDigest".into(),
                    args: vec![hash, encoding],
                    r#type: Type::String,
                    loc: self.loc(node),
                }));
            }
            let updates = update_nodes
                .iter()
                .map(|update| self.expected_expression(*update, Type::String))
                .collect::<Result<Vec<_>, _>>()?;
            (
                "crypto.hashStrings",
                Expr::ArrayLit {
                    elems: updates,
                    r#type: builtins::strings(),
                    loc: self.loc(node),
                },
            )
        };
        let encoding = self.expected_expression(digest_args[0], Type::String)?;
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args: vec![algorithm, data, encoding],
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }
}
