//! First-class synchronous functions and lexical capture boxes.
use super::*;
use source_frontend::prelude::SignatureKind;

impl Lowerer<'_> {
    pub(super) fn function_type(&mut self, id: TypeId) -> Option<Type> {
        if self.standard_console_type(id) {
            return Some(console::text_sink_type());
        }
        let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
        if signatures.len() != 1 {
            return None;
        }
        let signature = signatures[0];
        let sig = self.checker.sig(signature);
        if sig.this_parameter.0 != 0 {
            return None;
        }
        let rest = sig.has_rest_parameter();
        let generic = !sig.type_parameters.is_empty();
        let symbols = sig.parameters.clone();
        let count = symbols.len();
        let mut params = Vec::new();
        let mut array_rest = false;
        for (index, symbol) in symbols.into_iter().enumerate() {
            let id = self.checker.get_type_of_symbol(symbol);
            if rest && index + 1 == count {
                if !self.checker.is_tuple_type(id) {
                    if generic {
                        return None;
                    }
                    let ty = self.type_id(id)?;
                    if !matches!(ty, Type::Array { .. }) {
                        return None;
                    }
                    params.push(ty);
                    array_rest = true;
                    continue;
                }
                let target = self.checker.ty(id).target();
                let flags = self.checker.ty(target).as_tuple_type().element_flags();
                if flags.iter().any(|flag| {
                    flag.intersects(
                        source_frontend::flags::ElementFlags::REST
                            | source_frontend::flags::ElementFlags::VARIADIC,
                    )
                }) {
                    return None;
                }
                let elements = self.checker.get_type_arguments(id).to_vec();
                for (source, flag) in elements.into_iter().zip(flags) {
                    let mut ty = self.type_id(source)?;
                    if flag.intersects(source_frontend::flags::ElementFlags::OPTIONAL) {
                        let mut arms = if let Type::Union { union_id } = ty {
                            self.unions[union_id].arms.clone()
                        } else {
                            vec![ty]
                        };
                        arms.push(Type::Undefined);
                        ty = self.intern_union(arms)?;
                    }
                    params.push(ty);
                }
                continue;
            }
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
            rest: array_rest,
            params,
            ret: Box::new(ret),
        })
    }

    pub(super) fn resolve_binding(&mut self, symbol: u32, node: Node) -> Result<Local, String> {
        if let Some(local) = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
        {
            return Ok(local.clone());
        }
        let source = self
            .outer
            .iter()
            .rev()
            .find_map(|scope| scope.get(&symbol))
            .cloned()
            .ok_or_else(|| self.refuse(node, "unlowered binding"))?;
        // Both the lexical cell and its value are traced owning nodes.
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
        let Type::Func {
            params: types,
            ret,
            rest,
        } = &ty
        else {
            return Err(self.refuse(node, "callback needs a native function signature"));
        };
        if node.parameters().len() > types.len() {
            return Err(self.refuse(
                node,
                "callback requires more parameters than its native signature",
            ));
        }
        let parameters = node.parameters();
        let source_rest = parameters
            .iter()
            .last()
            .is_some_and(|p| !p.dot_dot_dot_token().is_nil());
        if source_rest != *rest {
            return Err(self.refuse(node, "callback rest ABI differs from its native target"));
        }
        for (index, param) in parameters.into_iter().enumerate() {
            if param.name().kind() != SyntaxKind::Identifier
                || (!param.dot_dot_dot_token().is_nil() && (!*rest || index + 1 != types.len()))
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
        let saved_this = self.instance_this.take();
        let saved_var_types = self.var_types.clone();
        let saved_var_defined = std::mem::take(&mut self.var_defined);
        let mut captured_scope = saved_bindings.clone();
        for (symbol, local) in &mut captured_scope {
            if local.r#type == Type::Caught {
                *local = self
                    .caught_aliases
                    .get(symbol)
                    .expect("catch snapshot")
                    .clone();
            }
        }
        self.outer.push(captured_scope);
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
        if node.body().kind() == SyntaxKind::Block {
            body.extend(self.hoist_local_vars(node.body())?);
        }
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
            rest: *rest,
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
        self.instance_this = saved_this;
        self.var_types = saved_var_types;
        self.var_defined = saved_var_defined;
        self.outer.pop();
        let mut sources = Vec::new();
        for (symbol, _) in captures {
            let caught = self
                .bindings
                .get(&symbol)
                .is_some_and(|local| local.r#type == Type::Caught);
            let source = if caught {
                self.caught_aliases[&symbol].clone()
            } else {
                self.resolve_binding(symbol, node)?
            };
            self.locals
                .iter_mut()
                .find(|l| l.id == source.id)
                .expect("binding local")
                .boxed = true;
            if caught {
                self.caught_aliases
                    .get_mut(&symbol)
                    .expect("catch snapshot")
                    .boxed = true;
            } else {
                self.bindings.get_mut(&symbol).expect("binding").boxed = true;
            }
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

    fn nullable_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let name = node.expression();
        if name.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let Ok(local) = self.binding(name) else {
            return Ok(None);
        };
        let Type::Union { union_id } = local.r#type else {
            return Ok(None);
        };
        let arms = &self.unions[union_id].arms;
        let functions = arms
            .iter()
            .filter(|t| matches!(t, Type::Func { .. }))
            .collect::<Vec<_>>();
        if functions.len() != 1
            || arms
                .iter()
                .any(|t| !matches!(t, Type::Func { .. } | Type::Null | Type::Undefined))
        {
            return Ok(None);
        }
        let ty = functions[0].clone();
        let Type::Func { params, ret, rest } = ty.clone() else {
            unreachable!()
        };
        let mut types = vec![local.r#type.clone()];
        types.extend(params.clone());
        let mut helper = helpers::Helper::new(
            &format!("nullable_call_{}", name.text()),
            types,
            (*ret).clone(),
            self.loc(node),
        );
        let callee = self.coerce(helper.read(&helper.param(0)), Type::Dyn, name)?;
        let call = if rest {
            Expr::CallValue {
                callee: Box::new(self.coerce(callee, ty, name)?),
                args: params
                    .iter()
                    .enumerate()
                    .map(|(i, _)| helper.read(&helper.param(i + 1)))
                    .collect(),
                r#type: (*ret).clone(),
                loc: self.loc(node),
            }
        } else {
            let args = params
                .iter()
                .enumerate()
                .map(|(i, _)| self.coerce(helper.read(&helper.param(i + 1)), Type::Dyn, node))
                .collect::<Result<Vec<_>, _>>()?;
            Expr::DynCall {
                callee: Box::new(callee),
                callee_name: name.text().into(),
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
        };
        if *ret == Type::Void {
            helper.function.body.push(Stmt::Expression {
                expr: call,
                loc: self.loc(node),
            });
        } else {
            helper.function.body.push(Stmt::Return {
                value: Some(self.coerce(call, (*ret).clone(), node)?),
                loc: self.loc(node),
            });
        }
        let callee = self.install_helper(helper.function);
        let mut args = vec![Expr::VarRef {
            local_id: local.id,
            r#type: local.r#type,
            loc: self.loc(name),
        }];
        args.extend(self.rest_call_arguments(node, &params, rest)?);
        Ok(Some(Expr::Call {
            callee,
            args,
            r#type: *ret,
            loc: self.loc(node),
        }))
    }

    pub(super) fn call_value(&mut self, node: Node) -> Result<Expr, String> {
        if let Some(value) = self.nullable_call(node)? {
            return Ok(value);
        }
        let value = self.expression(node.expression())?;
        let callee = self.callable_body(value, node)?;
        if callee.ty() == Type::Dyn {
            let args = node
                .arguments()
                .into_iter()
                .map(|n| self.expected_expression(n, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Expr::DynCall {
                callee: Box::new(callee),
                callee_name: "value".into(),
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let Type::Func { params, ret, rest } = callee.ty() else {
            return Err(self.refuse(node, "callee has no native function representation"));
        };
        let args = self.rest_call_arguments(node, &params, rest)?;
        Ok(Expr::CallValue {
            callee: Box::new(callee),
            args,
            r#type: *ret,
            loc: self.loc(node),
        })
    }
}
