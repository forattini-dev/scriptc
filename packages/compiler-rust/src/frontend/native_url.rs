//! WHATWG URL construction remains an identity-bearing native runtime value.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    pub(super) fn search_params_iteration_array(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression || !node.arguments().is_empty() {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(member.name().text(), "keys" | "values" | "entries")
        {
            return Ok(None);
        }
        let receiver_node = member.expression();
        let receiver_type = self.checker.get_type_at_location(receiver_node);
        if !self.standard_search_params_type(receiver_type) {
            return Ok(None);
        }
        let receiver = self.expression(receiver_node)?;
        let receiver = self.coerce(receiver, Type::Dyn, receiver_node)?;
        let method = member.name().text();
        let elem = if method == "entries" {
            Type::Array {
                elem: Box::new(Type::String),
            }
        } else {
            Type::String
        };
        Ok(Some(Expr::LibCall {
            r#fn: format!("searchParams.{method}Array"),
            args: vec![receiver],
            r#type: Type::Array {
                elem: Box::new(elem),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn search_params_keys_array(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression || !node.arguments().is_empty() {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "keys" {
            return Ok(None);
        }
        let receiver_node = member.expression();
        let receiver_type = self.checker.get_type_at_location(receiver_node);
        if !self.standard_search_params_type(receiver_type) {
            return Ok(None);
        }
        let receiver = self.expression(receiver_node)?;
        let receiver = self.coerce(receiver, Type::Dyn, receiver_node)?;
        Ok(Some(Expr::LibCall {
            r#fn: "searchParams.keysArray".into(),
            args: vec![receiver],
            r#type: Type::Array {
                elem: Box::new(Type::String),
            },
            loc: self.loc(node),
        }))
    }

    pub(super) fn standard_search_params_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 || self.checker.sym(symbol).name.as_ref() != "URLSearchParams" {
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
                    || path.ends_with("/@types/node/url.d.ts")
                    || path.contains("/bun-types/")
            })
    }

    pub(super) fn search_params_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        if callee.kind() != SyntaxKind::Identifier || callee.text() != "URLSearchParams" {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        if self.bindings.contains_key(&symbol)
            || self.module_bindings.contains_key(&symbol)
            || self.outer.iter().any(|scope| scope.contains_key(&symbol))
        {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 1
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "URLSearchParams construction supports zero or one string argument",
            ));
        }
        let (name, args) = if let Some(arg) = args.first() {
            (
                "searchParams.parseValue",
                vec![self.expected_expression(*arg, Type::String)?],
            )
        } else {
            ("searchParams.newValue", Vec::new())
        };
        Ok(Some(Expr::LibCall {
            r#fn: name.into(),
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn standard_url_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 || self.checker.sym(symbol).name.as_ref() != "URL" {
            return false;
        }
        let info = self.checker.sym(symbol);
        info.declarations.iter().any(|declaration| {
            if declaration.is_nil() {
                return false;
            }
            let path = source_file_info(get_source_file_of_node(*declaration))
                .file_name
                .replace('\\', "/");
            source_frontend::frontend::bundled::bundled_lib_name(&path).is_some()
                || path.ends_with("/@types/node/url.d.ts")
                || path.contains("/bun-types/")
        })
    }

    pub(super) fn standard_string_or_url_type(&self, id: TypeId) -> bool {
        let checked = self.checker.ty(id);
        if checked.flags.intersects(TypeFlags::STRING_LIKE) {
            return true;
        }
        if checked.flags.intersects(TypeFlags::UNION) {
            let arms = checked.types().to_vec();
            return !arms.is_empty()
                && arms
                    .into_iter()
                    .all(|arm| self.standard_string_or_url_type(arm));
        }
        self.standard_url_type(id)
    }

    pub(super) fn url_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let callee = node.expression();
        if callee.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let symbol = self.symbol(callee);
        let native = self.native_symbol(callee);
        let imported = self
            .native_functions
            .get(&native)
            .is_some_and(|(module, member)| *module == "url" && member == "URL");
        if callee.text() != "URL" && !imported {
            return Ok(None);
        }
        let ambient = !self.bindings.contains_key(&symbol)
            && !self.module_bindings.contains_key(&symbol)
            && !self.outer.iter().any(|scope| scope.contains_key(&symbol));
        if !ambient && !self.primitive_symbol(symbol, "URL", None) && !imported {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if !(1..=2).contains(&arguments.len())
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "URL construction requires an input string and optional base string",
            ));
        }
        let args = arguments
            .into_iter()
            .map(|argument| self.expected_expression(argument, Type::String))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Expr::LibCall {
            r#fn: if args.len() == 1 {
                "url.newValue".into()
            } else {
                "url.newValueBase".into()
            },
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
}
