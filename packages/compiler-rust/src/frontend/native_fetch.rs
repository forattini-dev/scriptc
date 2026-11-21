//! Fetch objects keep their native brand and identity behind NativeValue.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    pub(super) fn readable_stream_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        if callee.kind() != SyntaxKind::Identifier || callee.text() != "ReadableStream" {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        if self.standard_name(symbol, &["ReadableStream"]).is_none() {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "ReadableStream currently supports one start-only underlying source",
            ));
        }
        if let Some(source) = arguments.first()
            && source.kind() == SyntaxKind::ObjectLiteralExpression
        {
            for property in source.properties() {
                if property.kind() == SyntaxKind::PropertyAssignment
                    && property.name().kind() == SyntaxKind::Identifier
                    && property.name().text() == "type"
                {
                    let value = primitives::primitive_source(property.initializer());
                    if value.kind() != SyntaxKind::StringLiteral || value.text() != "bytes" {
                        return Err(self.refuse(
                            property,
                            "ReadableStream underlying source type must be the literal 'bytes'",
                        ));
                    }
                    // The native stream already owns byte chunks. The standard
                    // byte-source discriminator therefore changes no storage;
                    // retaining it on the source object is sufficient for
                    // callback `this` reads while construction validates it.
                    continue;
                }
                if !matches!(
                    property.kind(),
                    SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                ) || property.name().kind() != SyntaxKind::Identifier
                    || !matches!(property.name().text(), "start" | "pull" | "cancel")
                {
                    return Err(self.refuse(
                        property,
                        "ReadableStream underlying sources support start, pull, cancel, and type: 'bytes'",
                    ));
                }
                let callback = if property.kind() == SyntaxKind::MethodDeclaration {
                    property
                } else {
                    property.initializer()
                };
                for parameter in receivers::parameters(callback) {
                    if parameter.name().kind() != SyntaxKind::Identifier {
                        continue;
                    }
                    let symbol = self.symbol(parameter.name());
                    if symbol != 0 {
                        self.data_bindings.insert(symbol);
                        self.data_types
                            .insert(self.checker.get_type_at_location(parameter));
                    }
                }
            }
        }
        let source = if let Some(source) = arguments.first() {
            self.expected_expression(*source, Type::Dyn)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined".into(),
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                Type::Dyn,
                node,
            )?
        };
        Ok(Some(Expr::LibCall {
            r#fn: "web.readableStreamNew".into(),
            args: vec![source],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn text_decoder_stream_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        if callee.kind() != SyntaxKind::Identifier || callee.text() != "TextDecoderStream" {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        if self.standard_name(symbol, &["TextDecoderStream"]).is_none() {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(
                node,
                "TextDecoderStream currently supports the default UTF-8 constructor",
            ));
        }
        Ok(Some(Expr::LibCall {
            r#fn: "web.textDecoderStreamNew".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn transform_stream_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        if callee.kind() != SyntaxKind::Identifier || callee.text() != "TransformStream" {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        if self.standard_name(symbol, &["TransformStream"]).is_none() {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(
                node,
                "TransformStream construction currently requires zero arguments",
            ));
        }
        Ok(Some(Expr::LibCall {
            r#fn: "web.transformStreamNew".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn headers_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::NewExpression
            || node.expression().kind() != SyntaxKind::Identifier
            || node.expression().text() != "Headers"
        {
            return Ok(None);
        }
        let result = self.checker.get_type_at_location(node);
        if !self.standard_fetch_value_type(result) {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "Headers construction accepts at most one initializer"));
        }
        let init = if let Some(init) = arguments.first() {
            self.expected_expression(*init, Type::Dyn)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined".into(),
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                Type::Dyn,
                node,
            )?
        };
        Ok(Some(Expr::LibCall {
            r#fn: "fetch.headersNew".into(),
            args: vec![init],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn abort_controller_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        if callee.kind() != SyntaxKind::Identifier || callee.text() != "AbortController" {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        let result = self.checker.get_type_at_location(node);
        if self.bindings.contains_key(&symbol)
            || self.module_bindings.contains_key(&symbol)
            || self.outer.iter().any(|scope| scope.contains_key(&symbol))
            || !self.standard_fetch_value_type(result)
        {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "AbortController constructor takes no arguments"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: "abort.controllerNew".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
    pub(super) fn response_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::NewExpression
            || node.expression().kind() != SyntaxKind::Identifier
            || node.expression().text() != "Response"
        {
            return Ok(None);
        }
        let result = self.checker.get_type_at_location(node);
        if !self.standard_fetch_value_type(result) {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 2
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "Response construction accepts a body and an optional init object",
            ));
        }
        let body = if let Some(body) = arguments.first() {
            self.expected_expression(*body, Type::Dyn)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined".into(),
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                Type::Dyn,
                node,
            )?
        };
        let init = if let Some(init) = arguments.get(1) {
            self.expected_expression(*init, Type::Dyn)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined".into(),
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                Type::Dyn,
                node,
            )?
        };
        Ok(Some(Expr::LibCall {
            r#fn: "fetch.responseNew".into(),
            args: vec![body, init],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn ambient_fetch_call(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let target = node.expression();
        let binding = if target.kind() == SyntaxKind::Identifier && target.text() == "fetch" {
            target
        } else if target.kind() == SyntaxKind::PropertyAccessExpression
            && target.name().text() == "fetch"
            && target.expression().kind() == SyntaxKind::Identifier
            && target.expression().text() == "globalThis"
        {
            target.expression()
        } else {
            return false;
        };
        let symbol = self.symbol(binding);
        !self.bindings.contains_key(&symbol)
            && !self.module_bindings.contains_key(&symbol)
            && !self.outer.iter().any(|scope| scope.contains_key(&symbol))
    }

    pub(super) fn standard_fetch_value_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0
            || !matches!(
                self.checker.sym(symbol).name.as_ref(),
                "Response" | "Headers" | "RequestInit" | "AbortController" | "AbortSignal"
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
                let path = source_file_info(get_source_file_of_node(*declaration))
                    .file_name
                    .replace('\\', "/");
                source_frontend::frontend::bundled::bundled_lib_name(&path).is_some()
                    || path.contains("/node_modules/@types/node/web-globals/")
                    || path.contains("/node_modules/undici-types/")
                    || path.contains("/node_modules/bun-types/")
            })
    }

    pub(super) fn standard_headers_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "Headers"
            && self.standard_fetch_value_type(id)
    }
}
