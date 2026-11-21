//! Deletion is a Boolean property operation, separate from value assignment.
use super::*;

impl Lowerer<'_> {
    fn finite_string_delete_keys(&mut self, node: Node) -> Option<Vec<String>> {
        if let Some(key) = self.literal_property_key(node) {
            return Some(vec![key]);
        }
        let node = receivers::reference_node(node);
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return None;
        }
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        if declaration.is_nil() {
            return None;
        }
        let annotation = declaration.type_();
        if annotation.is_nil() {
            return None;
        }
        let parts = if annotation.kind() == SyntaxKind::UnionType {
            annotation.types().nodes().into_iter().collect::<Vec<_>>()
        } else {
            vec![annotation]
        };
        let mut keys = Vec::new();
        for part in parts {
            if part.kind() != SyntaxKind::LiteralType
                || part.literal().kind() != SyntaxKind::StringLiteral
            {
                return None;
            }
            let key = part.literal().text().to_string();
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        (!keys.is_empty()).then_some(keys)
    }

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
            if self.records[shape_id].tuple
                || self.callables.contains_key(&shape_id)
                || self.enum_shape(shape_id)
            {
                return Err(self.refuse(node, "specialized native record deletion is not ported"));
            }
            let keys = if member.kind() == SyntaxKind::PropertyAccessExpression {
                Some(vec![member.name().text().to_string()])
            } else {
                self.finite_string_delete_keys(member.argument_expression())
            };
            let shape = &self.records[shape_id];
            if shape.fields.iter().any(|field| {
                keys.as_ref().is_none_or(|keys| keys.contains(&field.name))
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
                | Type::Func { .. }
                | Type::Classval { .. }
                | Type::Object { .. }
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
        if matches!(receiver.ty(), Type::Func { .. } | Type::Classval { .. }) {
            self.function_member_key(member)?;
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
            if matches!(value.ty(), Type::Dyn | Type::Symbol) {
                let key = self.coerce(value, Type::Dyn, source)?;
                self.ensure_exception_classes(node)?;
                return Ok(Expr::LibCall {
                    r#fn: "dyn.keyDeleteComputed".into(),
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
                });
            }
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
