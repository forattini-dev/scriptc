//! Class value uses lower to portable typed IR operations.
use super::*;

impl Lowerer<'_> {
    fn class_ref(
        &mut self,
        index: usize,
        site: Node,
        prerequisite: Option<Expr>,
    ) -> Result<Expr, String> {
        self.request_constructor(index)?;
        let class_name = self.classes.definitions[index].name.clone();
        let ty = Type::Classval {
            class_name: class_name.clone(),
        };
        let value = Expr::ClassRef {
            class_name: class_name.clone(),
            r#type: ty.clone(),
            loc: self.loc(site),
        };
        let Some(prerequisite) = prerequisite else {
            return Ok(value);
        };
        let mut helper = helpers::Helper::new(
            &format!("class_{class_name}"),
            vec![prerequisite.ty()],
            ty.clone(),
            self.loc(site),
        );
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(site),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![prerequisite],
            r#type: ty,
            loc: self.loc(site),
        })
    }

    pub(in crate::frontend) fn class_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let symbol = self.symbol(node);
        let Some(index) = self.classes.symbols.get(&symbol).copied() else {
            return Ok(None);
        };
        let Some(token) = self.classes.definitions[index].token.clone() else {
            return Ok(None);
        };
        self.class_ref(index, node, Some(self.read_class_token(&token, node)))
            .map(Some)
    }

    pub(in crate::frontend) fn class_expression(&mut self, node: Node) -> Result<Expr, String> {
        let index = self
            .classes
            .definitions
            .iter()
            .position(|d| d.node == node)
            .ok_or_else(|| {
                self.refuse(
                    node,
                    "class expressions require a direct module initializer",
                )
            })?;
        self.resolve_class(index)?;
        let prerequisite = self.class_heritage_value(node)?;
        self.class_ref(index, node, prerequisite)
    }

    pub(super) fn class_heritage_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        for clause in node.heritage_clauses().nodes() {
            if clause.token() != SyntaxKind::ExtendsKeyword {
                continue;
            }
            let expression = clause
                .types()
                .nodes()
                .into_iter()
                .next()
                .unwrap()
                .expression();
            let index = self
                .class_symbol(expression)
                .ok_or_else(|| self.refuse(expression, "unresolved class heritage"))?;
            if !self.classes.definitions[index].node.is_nil() {
                // A declaration's heritage only reads its lexical identity;
                // defining an unused subclass must not demand its base body.
                let symbol = self.symbol(expression);
                if self.classes.symbols.get(&symbol).copied() == Some(index)
                    && let Some(token) = self.classes.definitions[index].token.clone()
                {
                    return Ok(Some(self.read_class_token(&token, expression)));
                }
                let value = self.expression(expression)?;
                if !matches!(value.ty(), Type::Classval { .. }) {
                    return Err(self.refuse(expression, "class heritage may be undefined"));
                }
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

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
        if self.classes.definitions[index].name == async_context::CLASS {
            if !node.arguments().is_empty() {
                return Err(
                    self.refuse(node, "AsyncLocalStorage constructor options are not ported")
                );
            }
            self.request_constructor(index)?;
            return Ok(Some(Expr::New {
                class_name: async_context::CLASS.into(),
                args: vec![],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index]
            .name
            .starts_with("native_builtin_Text")
        {
            if !node.arguments().is_empty() {
                return Err(self.refuse(
                    node,
                    "text codec constructor arguments/options are not ported",
                ));
            }
            self.request_constructor(index)?;
            return Ok(Some(Expr::New {
                class_name: self.classes.definitions[index].name.clone(),
                args: vec![],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        if self.classes.definitions[index].node.is_nil() {
            let message = self.error_message(node)?;
            return Ok(Some(Expr::LibCall {
                r#fn: "error.new".into(),
                args: vec![message],
                r#type: self.classes.object(index),
                loc: self.loc(node),
            }));
        }
        let callee = self.expression(node.expression())?;
        let expected = Type::Classval {
            class_name: self.classes.definitions[index].name.clone(),
        };
        if callee.ty() != expected {
            return Err(self.refuse(
                node,
                "constructor value may be undefined or has a different identity",
            ));
        }
        let params = self.request_constructor(index)?;
        let types = params
            .into_iter()
            .skip(1)
            .map(|p| p.r#type)
            .collect::<Vec<_>>();
        let args = self.method_arguments(node, &types)?;
        let result = self.classes.object(index);
        Ok(Some(Expr::NewValue {
            callee: Box::new(callee),
            args,
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
        let local = self.instance_this.as_ref().ok_or_else(|| {
            self.refuse(
                node,
                "this before super or outside a represented instance body is not ported",
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
            self.instance_this.as_ref().map(|l| l.r#type.clone())
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
        if class_name == async_context::CLASS {
            return Err(self.refuse(
                node,
                "AsyncLocalStorage property reads and extracted methods are not ported",
            ));
        }
        let ty = self
            .field_type(&class_name, &field)
            .ok_or_else(|| self.refuse(node, "class property is not ported"))?;
        let value = Expr::FieldGet {
            obj: Box::new(obj),
            class_name: class_name.clone(),
            field: field.clone(),
            r#type: ty,
            loc: self.loc(node),
        };
        if self.checker_any(node)
            && let Some(class) = self
                .classes
                .definitions
                .iter()
                .find(|class| class.name == class_name)
            && let Some(target) = self
                .class_contract(class.node)
                .and_then(|hint| hint.fields.iter().find(|(name, _)| *name == field))
                .and_then(|(_, ty)| ty.clone())
        {
            if value.ty() == target {
                return Ok(Some(value));
            }
            // A public JS declaration supplies a contract, not checker-local
            // inference for the implementation. Verify extraction from storage.
            let value = self.coerce(value, Type::Dyn, node)?;
            return Ok(Some(self.coerce(value, target, node)?));
        }
        Ok(Some(self.narrowed(value, node)?))
    }

    pub(in crate::frontend) fn class_set(&mut self, node: Node) -> Result<Option<Stmt>, String> {
        let member = node.left();
        let ty = if member.expression().kind() == SyntaxKind::ThisKeyword {
            self.instance_this.as_ref().map(|l| l.r#type.clone())
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
        if class_name == async_context::CLASS {
            return Err(self.refuse(node, "AsyncLocalStorage property writes are not ported"));
        }
        let ty = self
            .field_type(&class_name, &field)
            .ok_or_else(|| self.refuse(node, "class property write is not ported"))?;
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
        let value = if node.left().kind() == SyntaxKind::Identifier
            && let Ok(local) = self.binding(node.left())
            && local.r#type == Type::Caught
        {
            Expr::VarRef {
                local_id: local.id,
                r#type: Type::Caught,
                loc: self.loc(node.left()),
            }
        } else {
            self.expression(node.left())?
        };
        let index = self
            .class_symbol(node.right())
            .ok_or_else(|| self.refuse(node, "instanceof needs a resolved class"))?;
        self.layout_class(index)?;
        let class_name = self.classes.definitions[index].name.clone();
        let direct = matches!(value.ty(), Type::Object { class_name: left } if self.classes.hierarchy(&left) && self.classes.hierarchy(&class_name));
        let value = if value.ty() == Type::Caught || direct {
            value
        } else {
            self.coerce(value, Type::Dyn, node.left())?
        };
        let intrinsic = if self.classes.subclass(&class_name, "%Error") {
            "dyn.errInstanceof"
        } else {
            "dyn.classInstanceof"
        };
        let test = |value: Expr, loc: Loc| {
            if value.ty() == Type::Caught {
                Expr::CaughtTest {
                    value: Box::new(value),
                    test: "instanceof".into(),
                    class_name: class_name.clone(),
                    r#type: Type::Bool,
                    loc,
                }
            } else if value.ty() == Type::Dyn {
                Expr::LibCall {
                    r#fn: intrinsic.into(),
                    args: vec![
                        value,
                        Expr::StrLit {
                            value: class_name.clone(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        },
                    ],
                    r#type: Type::Bool,
                    loc,
                }
            } else {
                Expr::InstanceOf {
                    value: Box::new(value),
                    class_name: class_name.clone(),
                    r#type: Type::Bool,
                    loc,
                }
            }
        };
        if !self.classes.definitions[index].node.is_nil() {
            let constructor = self.expression(node.right())?;
            if !matches!(constructor.ty(), Type::Classval { .. }) {
                return Err(self.refuse(node.right(), "instanceof constructor may be undefined"));
            }
            let value = if value.ty() == Type::Caught {
                test(value, self.loc(node))
            } else {
                value
            };
            let mut helper = helpers::Helper::new(
                &format!("instanceof_{class_name}"),
                vec![value.ty(), constructor.ty()],
                Type::Bool,
                self.loc(node),
            );
            helper.function.body.push(Stmt::Return {
                value: Some(if value.ty() == Type::Bool {
                    helper.read(&helper.param(0))
                } else {
                    test(helper.read(&helper.param(0)), helper.loc())
                }),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            Ok(Expr::Call {
                callee,
                args: vec![value, constructor],
                r#type: Type::Bool,
                loc: self.loc(node),
            })
        } else {
            Ok(test(value, self.loc(node)))
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
