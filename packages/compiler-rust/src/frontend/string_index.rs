//! String keys address UTF-16 units; absence remains an owning undefined tag.
use super::*;

impl Lowerer<'_> {
    pub(super) fn string_method_receiver(
        &mut self,
        member: Node,
        receiver: Expr,
    ) -> Result<Expr, String> {
        if receiver.ty() == Type::String {
            return Ok(receiver);
        }
        if !self.string_view(&receiver.ty()) {
            return Err(self.refuse(
                member,
                "standard string methods require a represented string receiver",
            ));
        }
        self.ensure_exception_classes(member)?;
        let Type::Union { union_id } = receiver.ty() else {
            unreachable!()
        };
        let arms = self.unions[union_id].arms.clone();
        let mut helper = helpers::Helper::new(
            &format!("string_method_get_{}", member.name().text()),
            vec![receiver.ty()],
            Type::String,
            self.loc(member),
        );
        for (tag, arm) in arms.iter().enumerate() {
            let value = if *arm == Type::String {
                Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(helper.read(&helper.param(0))),
                    r#type: Type::String,
                    loc: helper.loc(),
                }
            } else {
                // GetValue of the method reference throws before argument
                // evaluation. A type-only non-null assertion cannot remove it.
                let unit = Expr::UnitLit {
                    unit: if *arm == Type::Null {
                        "null"
                    } else {
                        "undefined"
                    },
                    r#type: arm.clone(),
                    loc: helper.loc(),
                };
                let object = self.coerce(unit, Type::Dyn, member)?;
                let key = Expr::StrLit {
                    value: member.name().text().into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                };
                let read = self.dynamic_get(member, object, key);
                self.coerce(read, Type::String, member)?
            };
            let ret = Stmt::Return {
                value: Some(value),
                loc: helper.loc(),
            };
            if tag + 1 == arms.len() {
                helper.function.body.push(ret);
            } else {
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(helper.read(&helper.param(0))),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![ret],
                    else_: None,
                    loc: helper.loc(),
                });
            }
        }
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![receiver],
            r#type: Type::String,
            loc: self.loc(member),
        })
    }

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
