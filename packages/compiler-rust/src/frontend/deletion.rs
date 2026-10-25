//! Deletion is a Boolean property operation, separate from value assignment.
use super::*;

impl Lowerer<'_> {
    pub(super) fn delete_expression(&mut self, node: Node) -> Result<Expr, String> {
        let member = receivers::reference_node(node.expression());
        if !matches!(
            member.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) || member.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        {
            return Err(self.refuse(node, "only non-optional native property deletion is ported"));
        }
        let receiver = self.primitive_operand(member.expression())?;
        if let Type::Record { shape_id } = receiver.ty() {
            let shape = &self.records[shape_id];
            if shape.tuple || self.callables.contains_key(&shape_id) || self.enum_shape(shape_id) {
                return Err(self.refuse(node, "specialized native record deletion is not ported"));
            }
            let key = if member.kind() == SyntaxKind::PropertyAccessExpression {
                Some(member.name().text().to_string())
            } else {
                self.literal_property_key(member.argument_expression())
            };
            if shape.fields.iter().any(|field| {
                key.as_ref().is_none_or(|key| *key == field.name)
                    && field.r#type != Type::Dyn
                    && !self.optional_storage(&field.r#type)
            }) {
                return Err(self.refuse(
                    node,
                    "deleting required typed fields needs undefined-capable storage",
                ));
            }
        } else if let Type::Array { elem } = receiver.ty() {
            if *elem != Type::Dyn {
                return Err(self.refuse(
                    node,
                    "typed array deletion requires an owning undefined-capable element contract",
                ));
            }
        } else if !matches!(
            receiver.ty(),
            Type::Dyn
                | Type::String
                | Type::F64
                | Type::Bool
                | Type::Bigint
                | Type::Symbol
                | Type::Null
                | Type::Undefined
        ) {
            return Err(self.refuse(node, "native deletion receiver layout is not ported"));
        }
        let receiver = self.coerce(receiver, Type::Dyn, node)?;
        let key = if member.kind() == SyntaxKind::PropertyAccessExpression {
            Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            }
        } else {
            let source = member.argument_expression();
            let value = self.primitive_operand(source)?;
            if self.native_type_contains(&value.ty(), |ty| {
                !matches!(
                    ty,
                    Type::String
                        | Type::F64
                        | Type::Bool
                        | Type::Bigint
                        | Type::Null
                        | Type::Undefined
                        | Type::Union { .. }
                )
            }) {
                return Err(self.refuse(source, "deletion keys require represented non-symbol primitives; object coercion is not ported"));
            }
            self.string_value(value, source, strings::Context::Template)?
        };
        self.ensure_exception_classes(node)?;
        Ok(Expr::LibCall {
            r#fn: "dyn.keyDelete".into(),
            args: vec![
                receiver,
                key,
                Expr::BoolLit {
                    value: receivers::strict(node),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
            ],
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }
}
