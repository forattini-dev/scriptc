//! Private method brands precede fields; bodies enter the ordinary demand queue.
use super::*;

impl Lowerer<'_> {
    pub(in crate::frontend) fn initialize_private_methods(
        &mut self,
        owner: usize,
    ) -> Result<Vec<Stmt>, String> {
        let mut body = Vec::new();
        for method in self.classes.definitions[owner].node.members() {
            if !matches!(
                method.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
            ) || method.name().kind() != SyntaxKind::PrivateIdentifier
            {
                continue;
            }
            let slot = self.private_slot(method.name())?;
            let value = self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(method),
                },
                Type::Dyn,
                method,
            )?;
            let receiver = self.this_expression(method)?;
            body.push(Stmt::Expression {
                expr: self.private_access(&slot, receiver, Some(value), Access::Install, method)?,
                loc: self.loc(method),
            });
        }
        Ok(body)
    }

    pub(super) fn request_private_method(&mut self, slot: &Slot) -> Result<Signature, String> {
        if let Some(signature) = self.classes.private_method_signatures.get(&slot.global.id) {
            return Ok(signature.clone());
        }
        let node = slot.declaration;
        if !node.type_parameters().is_empty()
            || node.body().is_nil()
            || !node.asterisk_token().is_nil()
        {
            return Err(self.refuse(
                node,
                "demanded generic, overloaded or generator private methods are not ported",
            ));
        }
        self.layout_class(slot.owner)?;
        let file = std::mem::replace(
            &mut self.file,
            self.classes.definitions[slot.owner].file.clone(),
        );
        let signature = self.function_signature(node, slot.owner);
        self.file = file;
        let mut signature = signature?;
        signature.name = format!("%private.{}", slot.global.id);
        for (index, param) in signature.params.iter_mut().enumerate() {
            param.local_id = format!("p{}", index + 1);
        }
        signature.params.insert(
            0,
            Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: self.classes.object(slot.owner),
            },
        );
        self.classes
            .private_method_signatures
            .insert(slot.global.id.clone(), signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        Ok(signature)
    }

    pub(in crate::frontend) fn private_method_call(
        &mut self,
        call: Node,
    ) -> Result<Option<Expr>, String> {
        let member = call.expression();
        let slot = self.private_slot(member.name())?;
        if matches!(
            slot.declaration.kind(),
            SyntaxKind::PropertyDeclaration | SyntaxKind::GetAccessor
        ) {
            if !call.question_dot_token().is_nil() {
                return Err(self.refuse(call, "optional private field calls are not ported"));
            }
            // PrivateGet is a reference: evaluate the receiver once, perform
            // its brand check before the arguments, and keep it as `this`.
            let mut stmts = Vec::new();
            let receiver = self.private_receiver(member.expression())?;
            let receiver = self.update_temp(receiver, &mut stmts, member.expression());
            let target = if slot.declaration.kind() == SyntaxKind::GetAccessor {
                let signature = self.request_private_method(&slot)?;
                let checked = self.private_access(
                    &slot,
                    receiver.clone(),
                    None,
                    Access::MethodReceiver,
                    member,
                )?;
                let value = Expr::Call {
                    callee: signature.name,
                    args: vec![checked],
                    r#type: signature.return_type,
                    loc: self.loc(member),
                };
                self.coerce(value, Type::Dyn, member)?
            } else {
                self.private_access(&slot, receiver.clone(), None, Access::Read, member)?
            };
            let target = self.update_temp(target, &mut stmts, member);
            let args = self.array_spread_elements(
                call,
                call.arguments().into_iter().collect(),
                Type::Array {
                    elem: Box::new(Type::Dyn),
                },
            )?;
            let args = self.coerce(args, Type::Dyn, call)?;
            let receiver = self.coerce(receiver, Type::Dyn, member.expression())?;
            return Ok(Some(Expr::Sequence {
                stmts,
                result: Box::new(Expr::LibCall {
                    r#fn: "dyn.reflectApply".into(),
                    args: vec![target, receiver, args],
                    r#type: Type::Dyn,
                    loc: self.loc(call),
                }),
                r#type: Type::Dyn,
                loc: self.loc(call),
            }));
        }
        if slot.declaration.kind() != SyntaxKind::MethodDeclaration {
            return Ok(None);
        }
        let signature = self.request_private_method(&slot)?;
        let receiver = self.private_receiver(member.expression())?;
        let receiver = if matches!(receiver.ty(), Type::Union { .. }) {
            self.coerce(receiver, Type::Dyn, member.expression())?
        } else {
            receiver
        };
        // The first call operand performs PrivateGet, including its brand
        // check, before arguments, and retains the lexical declaration identity.
        let receiver =
            self.private_access(&slot, receiver, None, Access::MethodReceiver, member)?;
        let types = signature
            .params
            .iter()
            .skip(1)
            .map(|param| param.r#type.clone())
            .collect::<Vec<_>>();
        let args = std::iter::once(receiver)
            .chain(self.method_arguments(call, &types)?)
            .collect();
        Ok(Some(Expr::Call {
            callee: signature.name,
            args,
            r#type: signature.return_type,
            loc: self.loc(call),
        }))
    }
}
