//! Canonical iteration keys and receiver-explicit method demand.
use super::*;
use ir::SymbolMethodKey;

impl ClassGraph {
    pub(in crate::frontend) fn has_symbol_surface(&self, class_name: &str) -> bool {
        self.symbol_nodes.keys().any(|(owner, _)| {
            let name = &self.definitions[*owner].name;
            self.subclass(name, class_name) || self.subclass(class_name, name)
        })
    }
    fn symbol_method(&self, mut owner: usize, key: SymbolMethodKey) -> Option<(usize, Node)> {
        for _ in 0..=self.definitions.len() {
            if let Some(node) = self.symbol_nodes.get(&(owner, key)) {
                return Some((owner, *node));
            }
            owner = self.definitions[owner].base?;
        }
        None
    }
}

impl Lowerer<'_> {
    pub(super) fn class_symbol_key(&mut self, expression: Node) -> Option<SymbolMethodKey> {
        if expression.kind() != SyntaxKind::PropertyAccessExpression
            || !self.standard_symbol(expression.expression())
        {
            return None;
        }
        SymbolMethodKey::from_name(expression.name().text())
    }

    fn request_symbol_method(
        &mut self,
        owner: usize,
        key: SymbolMethodKey,
        node: Node,
    ) -> Result<Signature, String> {
        if let Some(signature) = self.classes.symbol_signatures.get(&(owner, key)) {
            return Ok(signature.clone());
        }
        self.layout_class(owner)?;
        if !node.type_parameters().is_empty()
            || node.body().is_nil()
            || !node.asterisk_token().is_nil()
        {
            return Err(self.refuse(
                node,
                "demanded generic, overloaded or generator symbol methods are not ported",
            ));
        }
        for member in self.classes.definitions[owner].node.members() {
            if member.kind() == SyntaxKind::MethodDeclaration
                && member.name().kind() == SyntaxKind::ComputedPropertyName
                && member.body().is_nil()
                && self.class_symbol_key(member.name().expression()) == Some(key)
            {
                return Err(self.refuse(member, "overloaded symbol method bodies are not ported"));
            }
        }
        let file = std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
        let signature = self.function_signature(node, owner);
        self.file = file;
        let mut signature = signature?;
        signature.name = key.function_name(&self.classes.definitions[owner].name);
        for (index, param) in signature.params.iter_mut().enumerate() {
            param.local_id = format!("p{}", index + 1);
        }
        signature.params.insert(
            0,
            Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: self.classes.object(owner),
            },
        );
        self.classes
            .symbol_signatures
            .insert((owner, key), signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        let descriptor = self.classes.layouts[owner]
            .as_mut()
            .unwrap()
            .symbol_methods
            .iter_mut()
            .find(|method| method.key == key)
            .unwrap();
        descriptor.function = Some(signature.name.clone());
        Ok(signature)
    }

    pub(in crate::frontend) fn class_symbol_call(
        &mut self,
        call: Node,
    ) -> Result<Option<Expr>, String> {
        let member = call.expression();
        if member.kind() != SyntaxKind::ElementAccessExpression {
            return Ok(None);
        }
        let Some(key) = self.class_symbol_key(member.argument_expression()) else {
            return Ok(None);
        };
        let receiver = member.expression();
        let is_super = receiver.kind() == SyntaxKind::SuperKeyword;
        let ty = if is_super || receiver.kind() == SyntaxKind::ThisKeyword {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
        } else {
            self.ty(receiver).ok()
        };
        let Some(Type::Object { class_name }) = ty else {
            return Ok(None);
        };
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|class| class.name == class_name)
        else {
            return Ok(None);
        };
        for child in 0..self.classes.definitions.len() {
            self.resolve_class(child)?;
        }
        let lookup = if is_super {
            self.classes.definitions[index].base.ok_or_else(|| {
                self.refuse(call, "super symbol method requires a derived instance")
            })?
        } else {
            index
        };
        let Some((owner, node)) = self.classes.symbol_method(lookup, key) else {
            return Ok(None);
        };
        let signature = self.request_symbol_method(owner, key, node)?;
        let mut variants = Vec::new();
        if !is_super {
            for child in 0..self.classes.definitions.len() {
                if child == index
                    || !self
                        .classes
                        .subclass(&self.classes.definitions[child].name, &class_name)
                {
                    continue;
                }
                if let Some((implementation, node)) = self.classes.symbol_method(child, key) {
                    let other = self.request_symbol_method(implementation, key, node)?;
                    if other.params.iter().skip(1).map(|p| &p.r#type).ne(signature
                        .params
                        .iter()
                        .skip(1)
                        .map(|p| &p.r#type))
                        || other.return_type != signature.return_type
                    {
                        return Err(self.refuse(node, "symbol method override requires an identical native parameter/result ABI"));
                    }
                    // Include inherited implementations too: a deeper class may
                    // inherit the base implementation after a sibling overrides it.
                    variants.push((child, other));
                }
            }
        }
        let object = if is_super {
            self.this_expression(receiver)?
        } else {
            self.expression(receiver)?
        };
        let object = self.coerce(object, self.classes.object(index), receiver)?;
        let types = signature
            .params
            .iter()
            .skip(1)
            .map(|p| p.r#type.clone())
            .collect::<Vec<_>>();
        let args = std::iter::once(object)
            .chain(self.method_arguments(call, &types)?)
            .collect::<Vec<_>>();
        let result = signature.return_type.clone();
        let mut helper = helpers::Helper::new(
            &format!("symbol_{class_name}_{}_{is_super}", key.name()),
            args.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(call),
        );
        variants.sort_by_key(|(child, _)| {
            let mut depth = 0;
            let mut base = self.classes.definitions[*child].base;
            while let Some(index) = base {
                depth += 1;
                base = self.classes.definitions[index].base;
            }
            std::cmp::Reverse(depth)
        });
        let invoke = |target: &Signature, helper: &helpers::Helper| {
            let object = helper.read(&helper.param(0));
            let target_type = target.params[0].r#type.clone();
            let Type::Object {
                class_name: target_name,
            } = &target_type
            else {
                unreachable!()
            };
            let object = if object.ty() == target_type {
                object
            } else if self.classes.subclass(&class_name, target_name) {
                Expr::Upcast {
                    value: Box::new(object),
                    r#type: target_type,
                    loc: helper.loc(),
                }
            } else {
                Expr::Downcast {
                    value: Box::new(object),
                    r#type: target_type,
                    loc: helper.loc(),
                }
            };
            let call = Expr::Call {
                callee: target.name.clone(),
                args: std::iter::once(object)
                    .chain((1..args.len()).map(|index| helper.read(&helper.param(index))))
                    .collect(),
                r#type: target.return_type.clone(),
                loc: helper.loc(),
            };
            if target.return_type == Type::Void {
                vec![
                    Stmt::Expression {
                        expr: call,
                        loc: helper.loc(),
                    },
                    Stmt::Return {
                        value: None,
                        loc: helper.loc(),
                    },
                ]
            } else {
                vec![Stmt::Return {
                    value: Some(call),
                    loc: helper.loc(),
                }]
            }
        };
        for (child, target) in variants {
            helper.function.body.push(Stmt::If {
                cond: Expr::InstanceOf {
                    value: Box::new(helper.read(&helper.param(0))),
                    class_name: self.classes.definitions[child].name.clone(),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: invoke(&target, &helper),
                else_: None,
                loc: helper.loc(),
            });
        }
        helper.function.body.extend(invoke(&signature, &helper));
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args,
            r#type: result,
            loc: self.loc(call),
        }))
    }
}
