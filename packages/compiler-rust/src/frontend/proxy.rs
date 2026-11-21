//! Native Proxy references retain target/handler identity and lower to Dyn.
use super::*;

impl Lowerer<'_> {
    /// Recognize the Node compatibility shim used to make an otherwise exact
    /// native constructor inheritable on runtimes with broken `newTarget`
    /// handling. Native class construction already preserves the derived
    /// layout, so this proxy has the same represented constructor identity.
    pub(super) fn constructor_proxy_expected(
        &mut self,
        node: Node,
        target: &Type,
    ) -> Result<Option<Expr>, String> {
        if !matches!(target, Type::Classval { .. }) || !self.is_proxy_new(node) {
            return Ok(None);
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let [constructor, handler] = arguments.as_slice() else {
            return Ok(None);
        };
        if handler.kind() != SyntaxKind::ObjectLiteralExpression {
            return Ok(None);
        }
        let properties = handler.properties().into_iter().collect::<Vec<_>>();
        let [trap] = properties.as_slice() else {
            return Ok(None);
        };
        if trap.kind() != SyntaxKind::MethodDeclaration
            || trap.name().kind() != SyntaxKind::Identifier
            || trap.name().text() != "construct"
            || trap.body().is_nil()
        {
            return Ok(None);
        }
        let params = trap.parameters().into_iter().collect::<Vec<_>>();
        if params.len() != 3
            || params.iter().any(|param| {
                param.name().kind() != SyntaxKind::Identifier
                    || !param.initializer().is_nil()
                    || !param.dot_dot_dot_token().is_nil()
            })
        {
            return Ok(None);
        }
        let target_symbol = self.symbol(params[0].name());
        let args_symbol = self.symbol(params[1].name());
        let new_target_symbol = self.symbol(params[2].name());
        let statements = trap.body().statements().into_iter().collect::<Vec<_>>();
        let [declaration, repair, returned] = statements.as_slice() else {
            return Ok(None);
        };
        if declaration.kind() != SyntaxKind::VariableStatement {
            return Ok(None);
        }
        let bindings = declaration
            .declaration_list()
            .declarations()
            .nodes()
            .into_iter()
            .collect::<Vec<_>>();
        let [binding] = bindings.as_slice() else {
            return Ok(None);
        };
        let instance = binding.name();
        let construct = binding.initializer();
        if instance.kind() != SyntaxKind::Identifier
            || construct.kind() != SyntaxKind::CallExpression
        {
            return Ok(None);
        }
        let construct_callee = construct.expression();
        let construct_args = construct.arguments().into_iter().collect::<Vec<_>>();
        let reflect_symbol = (construct_callee.kind() == SyntaxKind::PropertyAccessExpression)
            .then(|| self.symbol(construct_callee.expression()))
            .unwrap_or(0);
        if construct_callee.kind() != SyntaxKind::PropertyAccessExpression
            || construct_callee.name().text() != "construct"
            || construct_callee.expression().kind() != SyntaxKind::Identifier
            || !self.primitive_symbol(reflect_symbol, "Reflect", None)
            || construct_args.len() != 3
            || self.symbol(construct_args[0]) != target_symbol
            || self.symbol(construct_args[1]) != args_symbol
            || self.symbol(construct_args[2]) != target_symbol
        {
            return Ok(None);
        }
        if repair.kind() != SyntaxKind::ExpressionStatement
            || repair.expression().kind() != SyntaxKind::CallExpression
        {
            return Ok(None);
        }
        let repair_call = repair.expression();
        let repair_callee = repair_call.expression();
        let repair_args = repair_call.arguments().into_iter().collect::<Vec<_>>();
        if repair_callee.kind() != SyntaxKind::PropertyAccessExpression
            || repair_callee.name().text() != "setPrototypeOf"
            || !self.standard_object(repair_callee.expression())
            || repair_args.len() != 2
            || self.symbol(repair_args[0]) != self.symbol(instance)
            || repair_args[1].kind() != SyntaxKind::PropertyAccessExpression
            || repair_args[1].name().text() != "prototype"
            || self.symbol(repair_args[1].expression()) != new_target_symbol
            || returned.kind() != SyntaxKind::ReturnStatement
            || self.symbol(returned.expression()) != self.symbol(instance)
        {
            return Ok(None);
        }
        Ok(Some(
            self.expected_expression(*constructor, target.clone())?,
        ))
    }

    pub(super) fn is_proxy_new(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::NewExpression {
            return false;
        }
        let callee = primitives::primitive_source(node.expression());
        if callee.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(callee);
        self.primitive_symbol(symbol, "Proxy", None)
    }

    pub(super) fn proxy_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if !self.is_proxy_new(node) {
            return Ok(None);
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let [target, handler] = args.as_slice() else {
            return Err(self.refuse(
                node,
                "native Proxy construction requires exactly a target and handler",
            ));
        };
        if matches!(target.kind(), SyntaxKind::SpreadElement)
            || matches!(handler.kind(), SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "native Proxy arguments cannot be spread"));
        }
        let target_value = if target.kind() == SyntaxKind::ObjectLiteralExpression {
            self.dynamic_literal(*target)?
        } else {
            self.expression(*target)?
        };
        let target_value = self.coerce(target_value, Type::Dyn, *target)?;
        let handler_value = if handler.kind() == SyntaxKind::ObjectLiteralExpression {
            self.dynamic_literal(*handler)?
        } else {
            self.expression(*handler)?
        };
        let handler_value = self.coerce(handler_value, Type::Dyn, *handler)?;
        Ok(Some(Expr::LibCall {
            r#fn: "dyn.proxyNew".into(),
            args: vec![target_value, handler_value],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }
}
