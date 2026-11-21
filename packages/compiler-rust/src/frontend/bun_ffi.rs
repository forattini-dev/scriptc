//! Narrow, safe lowering for Bun's kernel32 console-mode FFI shape.
use super::*;

impl Lowerer<'_> {
    pub(super) fn bun_ffi_dlopen_call(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() != SyntaxKind::CallExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return false;
        }
        let native = self.native_symbol(node.expression());
        matches!(
            self.native_functions.get(&native),
            Some(("bun:ffi", member)) if member == "dlopen"
        )
    }

    fn bun_ffi_kernel_initializer(&mut self, node: Node) -> Option<Node> {
        let node = primitives::primitive_source(node);
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        if declaration.is_nil() || declaration.kind() != SyntaxKind::VariableDeclaration {
            return None;
        }
        let initializer = declaration.initializer();
        if initializer.is_nil() {
            // The detector is queried for every `.close()` call. A typed
            // variable such as `let server: Server` is not a Bun FFI handle
            // merely because it is assigned later and exposes that method.
            return None;
        }
        let initializer = primitives::primitive_source(initializer);
        self.bun_ffi_dlopen_call(initializer).then_some(initializer)
    }

    pub(super) fn bun_ffi_kernel_call(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() != SyntaxKind::CallExpression
            || node.expression().kind() != SyntaxKind::PropertyAccessExpression
        {
            return false;
        }
        let callee = node.expression();
        let kernel = if callee.name().text() == "close" {
            callee.expression()
        } else {
            let symbols = primitives::primitive_source(callee.expression());
            if symbols.kind() != SyntaxKind::PropertyAccessExpression
                || symbols.name().text() != "symbols"
            {
                return false;
            }
            symbols.expression()
        };
        self.bun_ffi_kernel_initializer(kernel).is_some()
    }

    pub(super) fn bun_ffi_dlopen(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 2
            || arguments[0].kind() != SyntaxKind::StringLiteral
            || !arguments[0].text().eq_ignore_ascii_case("kernel32.dll")
            || primitives::primitive_source(arguments[1]).kind()
                != SyntaxKind::ObjectLiteralExpression
        {
            return Err(self.refuse(
                node,
                "bun:ffi dlopen supports only the literal kernel32 console-mode descriptor",
            ));
        }
        let descriptor = primitives::primitive_source(arguments[1]);
        let mut names = descriptor
            .properties()
            .into_iter()
            .filter_map(|property| self.data_property_name(property.name()))
            .collect::<Vec<_>>();
        names.sort();
        if names != ["GetConsoleMode", "GetStdHandle", "SetConsoleMode"] {
            return Err(self.refuse(
                descriptor,
                "bun:ffi kernel32 descriptor must contain GetStdHandle, GetConsoleMode and SetConsoleMode",
            ));
        }
        Ok(Expr::LibCall {
            r#fn: "bun.ffi.consoleOpen".into(),
            args: vec![],
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }

    pub(super) fn bun_ffi_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || node.expression().kind() != SyntaxKind::PropertyAccessExpression
        {
            return Ok(None);
        }
        let callee = node.expression();
        let method = callee.name().text();
        let (kernel, symbol_method) = if method == "close" {
            (callee.expression(), None)
        } else {
            let symbols = primitives::primitive_source(callee.expression());
            if symbols.kind() != SyntaxKind::PropertyAccessExpression
                || symbols.name().text() != "symbols"
            {
                return Ok(None);
            }
            (symbols.expression(), Some(method))
        };
        if self.bun_ffi_kernel_initializer(kernel).is_none() {
            return Ok(None);
        }
        let token = self.expression(kernel)?;
        if token.ty() != Type::Bool {
            return Err(self.refuse(kernel, "bun:ffi kernel32 handle lost its native token"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let loc = self.loc(node);
        match symbol_method {
            None if arguments.is_empty() => Ok(Some(Expr::LibCall {
                r#fn: "bun.ffi.consoleClose".into(),
                args: vec![token],
                r#type: Type::Void,
                loc,
            })),
            Some("GetStdHandle") if arguments.len() == 1 => {
                let argument = primitives::primitive_source(arguments[0]);
                let valid = argument.kind() == SyntaxKind::PrefixUnaryExpression
                    && argument.operator() == SyntaxKind::MinusToken
                    && argument.operand().kind() == SyntaxKind::NumericLiteral
                    && source_frontend::jsnum::from_string(argument.operand().text()).value()
                        == 10.0;
                if !valid {
                    return Err(self.refuse(
                        arguments[0],
                        "native GetStdHandle supports only STD_INPUT_HANDLE (-10)",
                    ));
                }
                Ok(Some(token))
            }
            Some("GetConsoleMode") if arguments.len() == 2 => {
                let handle = self.expected_expression(arguments[0], Type::Bool)?;
                let output =
                    self.expected_expression(arguments[1], Type::Bytes { elem: "u32".into() })?;
                Ok(Some(Expr::LibCall {
                    r#fn: "bun.ffi.consoleGetMode".into(),
                    args: vec![handle, output],
                    r#type: Type::F64,
                    loc,
                }))
            }
            Some("SetConsoleMode") if arguments.len() == 2 => {
                let handle = self.expected_expression(arguments[0], Type::Bool)?;
                let mode = self.expected_expression(arguments[1], Type::F64)?;
                Ok(Some(Expr::LibCall {
                    r#fn: "bun.ffi.consoleSetMode".into(),
                    args: vec![handle, mode],
                    r#type: Type::F64,
                    loc,
                }))
            }
            _ => Err(self.refuse(
                node,
                "bun:ffi kernel32 call is outside the native console-mode contract",
            )),
        }
    }
}
