//! First-class synchronous functions and lexical capture boxes.
use super::*;
use goport_core::prelude::SignatureKind;

impl Lowerer<'_> {
    pub(super) fn function_type(&mut self, id: TypeId) -> Option<Type> {
        let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
        if signatures.len() != 1 {
            return None;
        }
        let signature = signatures[0];
        let sig = self.checker.sig(signature);
        if !sig.type_parameters.is_empty() || sig.has_rest_parameter() || sig.this_parameter.0 != 0
        {
            return None;
        }
        let symbols = sig.parameters.clone();
        let mut params = Vec::new();
        for symbol in symbols {
            let id = self.checker.get_type_of_symbol(symbol);
            let mut ty = self.type_id(id)?;
            let declaration = self.checker.sym(symbol).value_declaration;
            if !declaration.is_nil() && declaration.kind() == SyntaxKind::Parameter {
                ty = self.parameter_type(declaration, ty).ok()?;
            }
            if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
                return None;
            }
            params.push(ty);
        }
        let result = self.checker.get_return_type_of_signature(signature);
        let ret = if self.checker.ty(result).flags.intersects(TypeFlags::VOID) {
            Type::Void
        } else {
            self.type_id(result)?
        };
        if matches!(ret, Type::Null | Type::Undefined) {
            return None;
        }
        Some(Type::Func {
            params,
            ret: Box::new(ret),
        })
    }

    pub(super) fn resolve_binding(&mut self, symbol: u32, node: Node) -> Result<Local, String> {
        if let Some(local) = self.bindings.get(&symbol) {
            return Ok(local.clone());
        }
        let source = self
            .outer
            .iter()
            .rev()
            .find_map(|scope| scope.get(&symbol))
            .cloned()
            .ok_or_else(|| self.refuse(node, "unlowered binding"))?;
        // Function slots/containers need cycle collection before they may
        // participate in mutable closure environments. Other native values
        // have acyclic layouts, so Rc capture boxes cannot form a cycle.
        if matches!(source.r#type, Type::Func { .. }) {
            return Err(self.refuse(node, "capturing function-valued bindings is not ported"));
        }
        let local = Local {
            id: format!("c{}", self.captures.len()),
            name: source.name,
            r#type: source.r#type,
            mutable: source.mutable,
            boxed: true,
        };
        self.captures.push((
            symbol,
            Param {
                local_id: local.id.clone(),
                name: local.name.clone(),
                r#type: local.r#type.clone(),
            },
        ));
        self.bindings.insert(symbol, local.clone());
        self.locals.push(local.clone());
        Ok(local)
    }

    pub(super) fn closure(&mut self, node: Node, expected: Option<Type>) -> Result<Expr, String> {
        if !node.name().is_nil()
            || !node.asterisk_token().is_nil()
            || !node.type_parameters().is_empty()
            || node.modifier_flags().intersects(ModifierFlags::ASYNC)
        {
            return Err(self.refuse(
                node,
                "only anonymous synchronous non-generic function expressions are ported",
            ));
        }
        let ty = match expected {
            Some(ty) => ty,
            None => self.ty(node)?,
        };
        let Type::Func { params: types, ret } = &ty else {
            return Err(self.refuse(node, "callback needs a native function signature"));
        };
        if node.parameters().len() > types.len() {
            return Err(self.refuse(
                node,
                "callback requires more parameters than its native signature",
            ));
        }
        for param in node.parameters() {
            if param.name().kind() != SyntaxKind::Identifier
                || !param.dot_dot_dot_token().is_nil()
                || param.name().text() == "this"
            {
                return Err(self.refuse(param, "callback parameter form is not ported"));
            }
        }
        let name = format!("lambda{}", self.next_closure);
        self.next_closure += 1;
        let saved_locals = std::mem::take(&mut self.locals);
        let saved_bindings = std::mem::take(&mut self.bindings);
        let saved_captures = std::mem::take(&mut self.captures);
        let saved_return = self.return_type.replace((**ret).clone());
        self.outer.push(saved_bindings.clone());
        let nodes = node.parameters().into_iter().collect::<Vec<_>>();
        let mut params = Vec::new();
        let mut body = Vec::new();
        for (index, ty) in types.iter().enumerate() {
            let name = nodes
                .get(index)
                .map(|n| n.name().text().to_string())
                .unwrap_or_else(|| format!("ignored{index}"));
            let param = Param {
                local_id: format!("p{index}"),
                name,
                r#type: ty.clone(),
            };
            body.extend(self.bind_parameter(nodes.get(index).copied(), &param)?);
            params.push(param);
        }
        let loc = self.loc(node);
        body.extend(if node.body().kind() == SyntaxKind::Block {
            self.statements(node.body().statements())?
        } else if **ret == Type::Void {
            vec![
                Stmt::Expression {
                    expr: self.expression(node.body())?,
                    loc: self.loc(node.body()),
                },
                Stmt::Return {
                    value: None,
                    loc: loc.clone(),
                },
            ]
        } else {
            vec![Stmt::Return {
                value: Some(self.expected_expression(node.body(), (**ret).clone())?),
                loc: self.loc(node.body()),
            }]
        });
        if **ret != Type::Void && !ir::always_returns(&body) {
            return Err(self.refuse(node, "callback can fall through"));
        }
        let captures = std::mem::replace(&mut self.captures, saved_captures);
        let function = Function {
            name: name.clone(),
            params,
            captures: Some(captures.iter().map(|(_, p)| p.clone()).collect()),
            return_type: (**ret).clone(),
            locals: std::mem::replace(&mut self.locals, saved_locals),
            body,
            loc: loc.clone(),
        };
        self.bindings = saved_bindings;
        self.return_type = saved_return;
        self.outer.pop();
        let mut sources = Vec::new();
        for (symbol, _) in captures {
            let source = self.resolve_binding(symbol, node)?;
            self.locals
                .iter_mut()
                .find(|l| l.id == source.id)
                .expect("binding local")
                .boxed = true;
            self.bindings.get_mut(&symbol).expect("binding").boxed = true;
            sources.push(source.id);
        }
        self.lifted.push(function);
        Ok(Expr::Closure {
            fn_name: name,
            captures: sources,
            r#type: ty,
            loc,
        })
    }

    pub(super) fn call_value(&mut self, node: Node) -> Result<Expr, String> {
        let callee = self.expression(node.expression())?;
        let Type::Func { params, ret } = callee.ty() else {
            return Err(self.refuse(node, "callee has no native function representation"));
        };
        let args = self.call_arguments(node, &params)?;
        Ok(Expr::CallValue {
            callee: Box::new(callee),
            args,
            r#type: *ret,
            loc: self.loc(node),
        })
    }
}
