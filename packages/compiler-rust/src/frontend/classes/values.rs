//! Class value uses lower to portable typed IR operations.
use super::*;

impl Lowerer<'_> {
    pub(super) fn read_class_token(&self, token: &Local, site: Node) -> Expr {
        Expr::VarRef {
            local_id: token.id.clone(),
            r#type: Type::F64,
            loc: self.loc(site),
        }
    }

    pub(in crate::frontend) fn class_new(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(index) = self.class_symbol(node.expression()) else {
            return Ok(None);
        };
        if self.classes.definitions[index].node.is_nil() {
            let message = self.error_message(node)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "error.new".into(),
                args: vec![message],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        let params = self.request_constructor(index)?;
        let types = params
            .into_iter()
            .skip(1)
            .map(|p| p.r#type)
            .collect::<Vec<_>>();
        let args = self.call_arguments(node, &types)?;
        let token = self.classes.definitions[index].token.clone().unwrap();
        let result = self.classes.object(index);
        let name = self.classes.definitions[index].name.clone();
        let mut helper = helpers::Helper::new(
            &format!("new_{name}"),
            std::iter::once(Type::F64).chain(types).collect(),
            result.clone(),
            self.loc(node),
        );
        let values = helper
            .function
            .params
            .iter()
            .skip(1)
            .map(|p| Expr::VarRef {
                local_id: p.local_id.clone(),
                r#type: p.r#type.clone(),
                loc: helper.loc(),
            })
            .collect();
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::New {
                class_name: name,
                args: values,
                r#type: result.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: std::iter::once(self.read_class_token(&token, node))
                .chain(args)
                .collect(),
            r#type: result,
            loc: self.loc(node),
        }))
    }

    pub(super) fn error_message(&mut self, node: Node) -> Result<Expr, String> {
        if node.arguments().len() > 1 {
            return Err(self.refuse(node, "Error options/cause are not ported"));
        }
        let value = node
            .arguments()
            .into_iter()
            .next()
            .map(|n| self.expression(n))
            .transpose()?;
        self.message_value(value, node)
    }
    pub(super) fn message_value(
        &mut self,
        value: Option<Expr>,
        node: Node,
    ) -> Result<Expr, String> {
        let empty = || Expr::StrLit {
            value: String::new(),
            r#type: Type::String,
            loc: self.loc(node),
        };
        match value {
            None
            | Some(Expr::UnitLit {
                r#type: Type::Undefined,
                ..
            }) => Ok(empty()),
            Some(value) if value.ty() == Type::String => Ok(value),
            Some(value) => {
                let Type::Union { union_id } = value.ty() else {
                    return Err(self.refuse(node, "Error message string conversion is not ported"));
                };
                let arms = &self.unions[union_id].arms;
                if arms.len() != 2
                    || !arms.contains(&Type::String)
                    || !arms.contains(&Type::Undefined)
                {
                    return Err(self.refuse(node, "Error message type is not ported"));
                }
                let mut helper = helpers::Helper::new(
                    "error_message",
                    vec![value.ty()],
                    Type::String,
                    self.loc(node),
                );
                let tag = arms.iter().position(|a| *a == Type::String).unwrap();
                helper.function.body.push(Stmt::Return {
                    value: Some(Expr::Ternary {
                        cond: Box::new(Expr::UnionIsTag {
                            union_id: format!("u{union_id}"),
                            tag,
                            negated: false,
                            value: Box::new(helper.read(&helper.param(0))),
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        then: Box::new(Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(helper.read(&helper.param(0))),
                            r#type: Type::String,
                            loc: helper.loc(),
                        }),
                        else_: Box::new(empty()),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                });
                let callee = self.install_helper(helper.function);
                Ok(Expr::Call {
                    callee,
                    args: vec![value],
                    r#type: Type::String,
                    loc: self.loc(node),
                })
            }
        }
    }

    pub(in crate::frontend) fn this_expression(&self, node: Node) -> Result<Expr, String> {
        let local = self.constructor_this.as_ref().ok_or_else(|| {
            self.refuse(
                node,
                "this before super or outside a native constructor is not ported",
            )
        })?;
        Ok(Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        })
    }

    pub(super) fn field_type(&self, class: &str, field: &str) -> Option<Type> {
        self.classes
            .layouts
            .iter()
            .flatten()
            .find(|c| c.name == class)?
            .fields
            .iter()
            .find(|f| f.name == field)
            .map(|f| f.r#type.clone())
    }

    pub(in crate::frontend) fn class_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        // Probe the type without lowering the receiver twice (calls can enqueue helpers).
        let ty = if node.expression().kind() == SyntaxKind::ThisKeyword {
            self.constructor_this.as_ref().map(|l| l.r#type.clone())
        } else {
            self.ty(node.expression()).ok()
        };
        if !matches!(ty, Some(Type::Object { .. })) {
            return Ok(None);
        }
        let obj = self.expression(node.expression())?;
        let Type::Object { class_name } = obj.ty() else {
            return Err(self.refuse(node, "class receiver has no object representation"));
        };
        let field = node.name().text().to_string();
        let ty = self
            .field_type(&class_name, &field)
            .ok_or_else(|| self.refuse(node, "Error property is not ported"))?;
        let value = Expr::FieldGet {
            obj: Box::new(obj),
            class_name,
            field,
            r#type: ty,
            loc: self.loc(node),
        };
        Ok(Some(self.narrowed(value, node)?))
    }

    pub(in crate::frontend) fn class_set(&mut self, node: Node) -> Result<Option<Stmt>, String> {
        let member = node.left();
        let ty = if member.expression().kind() == SyntaxKind::ThisKeyword {
            self.constructor_this.as_ref().map(|l| l.r#type.clone())
        } else {
            self.ty(member.expression()).ok()
        };
        if !matches!(ty, Some(Type::Object { .. })) {
            return Ok(None);
        }
        let obj = self.expression(member.expression())?;
        let Type::Object { class_name } = obj.ty() else {
            return Err(self.refuse(node, "class write needs an object"));
        };
        let field = member.name().text().to_string();
        let ty = self
            .field_type(&class_name, &field)
            .ok_or_else(|| self.refuse(node, "Error property write is not ported"))?;
        let value = self.expected_expression(node.right(), ty)?;
        Ok(Some(Stmt::FieldSet {
            obj,
            class_name,
            field,
            value,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn class_instanceof(&mut self, node: Node) -> Result<Expr, String> {
        let value = self.expression(node.left())?;
        if !matches!(value.ty(), Type::Object { .. }) {
            return Err(self.refuse(node, "instanceof currently requires a native Error object"));
        }
        let index = self
            .class_symbol(node.right())
            .ok_or_else(|| self.refuse(node, "instanceof needs a resolved Error class"))?;
        self.layout_class(index)?;
        let class_name = self.classes.definitions[index].name.clone();
        if let Some(token) = self.classes.definitions[index].token.clone() {
            let mut helper = helpers::Helper::new(
                &format!("instanceof_{class_name}"),
                vec![value.ty(), Type::F64],
                Type::Bool,
                self.loc(node),
            );
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::InstanceOf {
                    value: Box::new(helper.read(&helper.param(0))),
                    class_name,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            Ok(Expr::Call {
                callee,
                args: vec![value, self.read_class_token(&token, node)],
                r#type: Type::Bool,
                loc: self.loc(node),
            })
        } else {
            Ok(Expr::InstanceOf {
                value: Box::new(value),
                class_name,
                r#type: Type::Bool,
                loc: self.loc(node),
            })
        }
    }

    pub(in crate::frontend) fn error_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "toString"
        {
            return Ok(None);
        }
        if !matches!(self.ty(member.expression()), Ok(Type::Object { .. })) {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "Error.toString takes no arguments"));
        }
        let value = self.expression(member.expression())?;
        let value = self.coerce(
            value,
            Type::Object {
                class_name: "%Error".into(),
            },
            node,
        )?;
        Ok(Some(Expr::LibCall {
            r#fn: "error.toString".into(),
            args: vec![value],
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }
}
