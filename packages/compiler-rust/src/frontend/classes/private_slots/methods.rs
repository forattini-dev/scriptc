//! Private method brands precede fields; bodies enter the ordinary demand queue.
use super::*;

impl Lowerer<'_> {
    pub(in crate::frontend) fn initialize_private_methods(
        &mut self,
        owner: usize,
    ) -> Result<Vec<Stmt>, String> {
        let mut body = Vec::new();
        for method in self.classes.definitions[owner].node.members() {
            if method.kind() != SyntaxKind::MethodDeclaration
                || method.name().kind() != SyntaxKind::PrivateIdentifier
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

    fn request_private_method(&mut self, slot: &Slot) -> Result<Signature, String> {
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
