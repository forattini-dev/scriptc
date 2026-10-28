//! Direct static calls whose bodies do not observe a class receiver.
use super::*;

pub(super) fn reads_super(node: Node) -> bool {
    if node.kind() == SyntaxKind::SuperKeyword {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        found |= reads_super(child);
        false
    });
    found
}

impl Lowerer<'_> {
    pub(in crate::frontend) fn class_static_call(
        &mut self,
        call: Node,
    ) -> Result<Option<Expr>, String> {
        let member = call.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let receiver = member.expression();
        let Some(index) = self.class_symbol(receiver) else {
            return Ok(None);
        };
        let definition = self.classes.definitions[index].clone();
        if definition.node.is_nil()
            || definition.token.is_none()
            || self.symbol(receiver) != self.symbol(definition.node.name())
        {
            return Ok(None);
        }
        self.resolve_class(index)?;
        let name = member.name().text().to_string();
        let mut owner = Some(index);
        let mut found = None;
        while let Some(current) = owner {
            let definition = &self.classes.definitions[current];
            if !definition.node.is_nil()
                && let Some(node) = definition.node.members().into_iter().rev().find(|node| {
                    node.kind() == SyntaxKind::MethodDeclaration
                        && node.modifier_flags().intersects(ModifierFlags::STATIC)
                        && node.name().text() == name
                })
            {
                found = Some((current, node));
                break;
            }
            owner = definition.base;
        }
        let Some((owner, node)) = found else {
            return Ok(None);
        };
        let key = (owner, name.clone());
        let signature = if let Some(signature) = self.classes.static_methods.get(&key) {
            signature.clone()
        } else {
            if !node.type_parameters().is_empty() || node.body().is_nil() {
                return Err(
                    self.refuse(node, "generic and overloaded static methods are not ported")
                );
            }
            let file =
                std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
            let signature = self.function_signature(node, owner);
            self.file = file;
            let mut signature = signature?;
            signature.name = format!("%{}.static.{name}", self.classes.definitions[owner].name);
            self.classes.static_methods.insert(key, signature.clone());
            self.classes.method_queue.push_back(signature.clone());
            signature
        };
        let types = signature
            .params
            .iter()
            .map(|p| p.r#type.clone())
            .collect::<Vec<_>>();
        let args = self.method_arguments(call, &types)?;
        let result = Expr::Call {
            callee: signature.name,
            args,
            r#type: signature.return_type.clone(),
            loc: self.loc(call),
        };
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: self.read_class_token(definition.token.as_ref().unwrap(), receiver),
                loc: self.loc(receiver),
            }],
            result: Box::new(result),
            r#type: signature.return_type,
            loc: self.loc(call),
        }))
    }
}
