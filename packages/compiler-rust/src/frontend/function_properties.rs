//! Ordinary data properties retain the owning callable rather than a copied record.
use super::*;

pub(super) fn owning_read(value: &Expr) -> bool {
    matches!(value, Expr::DynKeyGet { value, .. }
        if matches!(value.as_ref(), Expr::DynFrom { value, .. }
            if matches!(value.ty(), Type::Func { .. })))
}

impl Lowerer<'_> {
    pub(super) fn function_data_key(&self, node: Node, key: &str) -> Result<(), String> {
        if matches!(
            key,
            "name"
                | "length"
                | "bind"
                | "call"
                | "apply"
                | "prototype"
                | "caller"
                | "arguments"
                | "constructor"
                | "__proto__"
                | "toString"
                | "valueOf"
                | "hasOwnProperty"
                | "isPrototypeOf"
                | "propertyIsEnumerable"
                | "toLocaleString"
        ) {
            return Err(self.refuse(
                node,
                "intrinsic function properties require their native member contract",
            ));
        }
        Ok(())
    }

    pub(super) fn function_member_key(&self, member: Node) -> Result<(), String> {
        let key = if member.kind() == SyntaxKind::PropertyAccessExpression {
            Some(member.name().text().to_owned())
        } else {
            self.literal_property_key(member.argument_expression())
        };
        if let Some(key) = key {
            self.function_data_key(member, &key)?;
        }
        Ok(())
    }
}
