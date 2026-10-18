//! Instance method discovery, demand and closed-hierarchy dispatch.
use super::*;

impl ClassGraph {
    pub fn next_method(&mut self) -> Option<Signature> {
        self.method_queue.pop_front()
    }

    pub(super) fn method(&self, mut owner: usize, name: &str) -> Option<(usize, Node)> {
        for _ in 0..=self.definitions.len() {
            let definition = &self.definitions[owner];
            if !definition.node.is_nil()
                && let Some(node) = definition.node.members().into_iter().rev().find(|node| {
                    node.kind() == SyntaxKind::MethodDeclaration && node.name().text() == name
                })
            {
                return Some((owner, node));
            }
            owner = definition.base?;
        }
        None
    }
}

impl Lowerer<'_> {
    fn request_method(
        &mut self,
        owner: usize,
        name: &str,
        node: Node,
    ) -> Result<Signature, String> {
        let key = (owner, name.to_string());
        if let Some(signature) = self.classes.methods.get(&key) {
            return Ok(signature.clone());
        }
        self.layout_class(owner)?;
        if !node.type_parameters().is_empty()
            || self.classes.definitions[owner]
                .node
                .members()
                .into_iter()
                .any(|member| {
                    member.kind() == SyntaxKind::MethodDeclaration
                        && member.name().text() == name
                        && member.body().is_nil()
                })
        {
            return Err(self.refuse(node, "generic and overloaded method bodies are not ported"));
        }
        if let Some(hint) = self
            .class_contract(self.classes.definitions[owner].node)
            .and_then(|hint| hint.methods.iter().find(|(method, _)| method == name))
            .cloned()
        {
            let Some(Type::Func {
                params,
                ret,
                rest: false,
            }) = hint.1
            else {
                return Err(self.refuse(node, "public method has no native call signature"));
            };
            self.declarations.insert(
                declarations::Key::of(node),
                declarations::Hint {
                    rest: false,
                    params: params.into_iter().map(Some).collect(),
                    ret: Some(*ret),
                    reason: None,
                    value_type: None,
                    class: None,
                },
            );
        }
        let file = std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
        let signature = self.function_signature(node, owner);
        self.file = file;
        let mut signature = signature?;
        let class = self.classes.definitions[owner].name.clone();
        signature.name = format!("%{class}.{name}");
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
        self.classes.methods.insert(key, signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        let layout = self.classes.layouts[owner].as_mut().unwrap();
        layout.methods.push(name.into());
        let node = self.classes.definitions[owner].node;
        layout.methods.sort_by_key(|name| {
            node.members()
                .into_iter()
                .rfind(|member| {
                    member.kind() == SyntaxKind::MethodDeclaration && member.name().text() == name
                })
                .unwrap()
                .pos()
        });
        Ok(signature)
    }

    pub(in crate::frontend) fn class_call(&mut self, call: Node) -> Result<Option<Expr>, String> {
        let member = call.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
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
        let index = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == class_name)
            .unwrap();
        self.resolve_class(index)?;
        let lookup = if is_super {
            self.classes.definitions[index]
                .base
                .ok_or_else(|| self.refuse(call, "super method requires a derived instance body"))?
        } else {
            index
        };
        let name = member.name().text();
        let Some((owner, node)) = self.classes.method(lookup, name) else {
            return Ok(None);
        };
        // All source definitions are known, even when a later module statement
        // has not yet initialized its class value. Do not read class tokens here.
        for child in 0..self.classes.definitions.len() {
            self.resolve_class(child)?;
        }
        let signature = self.request_method(owner, name, node)?;
        let mut overridden = false;
        if !is_super {
            for child in 0..self.classes.definitions.len() {
                if child == index
                    || !self
                        .classes
                        .subclass(&self.classes.definitions[child].name, &class_name)
                {
                    continue;
                }
                if let Some((implementation, node)) = self.classes.method(child, name)
                    && implementation != owner
                {
                    let other = self.request_method(implementation, name, node)?;
                    if other.params.iter().skip(1).map(|p| &p.r#type).ne(signature
                        .params
                        .iter()
                        .skip(1)
                        .map(|p| &p.r#type))
                        || other.return_type != signature.return_type
                    {
                        return Err(self.refuse(
                            node,
                            "method override requires an identical native parameter/result ABI",
                        ));
                    }
                    overridden = true;
                }
            }
        }
        let object = if is_super {
            self.this_expression(receiver)?
        } else {
            self.expression(receiver)?
        };
        let object = self.coerce(
            object,
            if overridden {
                self.classes.object(index)
            } else {
                self.classes.object(owner)
            },
            receiver,
        )?;
        let types = signature
            .params
            .iter()
            .skip(1)
            .map(|p| p.r#type.clone())
            .collect::<Vec<_>>();
        let args = std::iter::once(object)
            .chain(self.method_arguments(call, &types)?)
            .collect();
        Ok(Some(if overridden {
            Expr::VirtualCall {
                class_name,
                method: name.into(),
                args,
                r#type: signature.return_type,
                loc: self.loc(call),
            }
        } else {
            Expr::Call {
                callee: signature.name,
                args,
                r#type: signature.return_type,
                loc: self.loc(call),
            }
        }))
    }
}
