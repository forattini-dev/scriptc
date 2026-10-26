//! String keys address UTF-16 units; absence remains an owning undefined tag.
use super::*;

impl Lowerer<'_> {
    pub(super) fn string_view(&self, ty: &Type) -> bool {
        match ty {
            Type::String => true,
            Type::Union { union_id } => {
                let arms = &self.unions[*union_id].arms;
                arms.contains(&Type::String)
                    && arms
                        .iter()
                        .all(|arm| matches!(arm, Type::String | Type::Null | Type::Undefined))
            }
            _ => false,
        }
    }

    pub(super) fn string_index_type(&mut self, node: Node) -> Result<Type, String> {
        let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
            Some(node.name().text().to_string())
        } else {
            self.literal_property_key(primitives::primitive_source(node.argument_expression()))
        };
        if name.as_deref() == Some("length") {
            return Ok(Type::F64);
        }
        if node.kind() != SyntaxKind::ElementAccessExpression {
            return Err(self.refuse(node, "string members require their native builtin contract"));
        }
        if name.is_some() {
            // Builtin methods and prototypes must retain their callable ABI.
            // Named own string properties consist only of UTF-16 indices/length.
            let supported = self.ty(node).is_ok_and(|ty| {
                !self.native_type_contains(&ty, |arm| {
                    !matches!(
                        arm,
                        Type::String | Type::Undefined | Type::Dyn | Type::Union { .. }
                    )
                })
            });
            if !supported {
                return Err(self.refuse(
                    node,
                    "named string members require their native builtin contract",
                ));
            }
        } else {
            let key = self.ty(primitives::primitive_source(node.argument_expression()))?;
            if self.native_type_contains(&key, |ty| {
                !matches!(
                    ty,
                    Type::F64
                        | Type::Bool
                        | Type::Bigint
                        | Type::Null
                        | Type::Undefined
                        | Type::Union { .. }
                )
            }) {
                return Err(self.refuse(node, "string indexing requires a represented primitive numeric key or a literal property name"));
            }
        }
        self.undefined_storage_type(Type::String, node)
    }

    pub(super) fn string_index(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        let result = self.string_index_type(node)?;
        let key = if node.kind() == SyntaxKind::PropertyAccessExpression {
            Expr::StrLit {
                value: node.name().text().into(),
                r#type: Type::String,
                loc: self.loc(node),
            }
        } else {
            let source = primitives::primitive_source(node.argument_expression());
            let value = self.primitive_operand(source)?;
            self.string_value(value, source, strings::Context::Template)?
        };
        let object = self.coerce(receiver, Type::Dyn, node)?;
        let value = self.dynamic_get(node, object, key);
        self.ensure_exception_classes(node)?;
        self.coerce(value, result, node)
    }
}
