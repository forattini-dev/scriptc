use super::*;

impl Lowerer<'_> {
    fn inspector_session_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 || self.checker.sym(symbol).name.as_ref() != "Session" {
            return false;
        }
        self.checker
            .sym(symbol)
            .declarations
            .iter()
            .any(|declaration| {
                let mut node = *declaration;
                while !node.is_nil() && node.kind() != SyntaxKind::SourceFile {
                    if node.kind() == SyntaxKind::ModuleDeclaration
                        && node.name().text() == "node:inspector"
                    {
                        return true;
                    }
                    node = node.parent();
                }
                source_file_info(node)
                    .file_name
                    .contains("@types/node/inspector")
            })
    }

    pub(super) fn inspector_session_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::NewExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let symbol = self.native_symbol(node.expression());
        if !self
            .native_functions
            .get(&symbol)
            .is_some_and(|(module, member)| *module == "inspector" && member == "Session")
        {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "inspector.Session constructor takes no arguments"));
        }
        Ok(Some(Expr::Intrinsic {
            name: "inspector.session.new".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    pub(super) fn inspector_session_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
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
        if !self.inspector_session_type(receiver_id) {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let receiver = self.expected_expression(access.expression(), Type::Dyn)?;
        let loc = self.loc(node);
        let (name, args) = match access.name().text() {
            "connect" | "disconnect" if arguments.is_empty() => (
                format!("inspector.session.{}", access.name().text()),
                vec![receiver],
            ),
            "post" if matches!(arguments.len(), 2 | 3) => {
                let params = if arguments.len() == 3 {
                    self.expected_expression(arguments[1], Type::Dyn)?
                } else {
                    self.coerce(
                        Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: loc.clone(),
                        },
                        Type::Dyn,
                        node,
                    )?
                };
                (
                    "inspector.session.post".into(),
                    vec![
                        receiver,
                        self.expected_expression(arguments[0], Type::String)?,
                        params,
                        self.expected_expression(*arguments.last().unwrap(), Type::Dyn)?,
                    ],
                )
            }
            name => {
                return Err(self.refuse(
                    node,
                    &format!("inspector.Session.{name} overload is not ported"),
                ));
            }
        };
        Ok(Some(Expr::Intrinsic {
            name,
            args,
            r#type: Type::Void,
            loc,
        }))
    }
}
