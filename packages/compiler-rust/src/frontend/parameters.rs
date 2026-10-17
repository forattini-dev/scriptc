//! Fixed native call slots; omission is an undefined tag, defaults run in the callee.
use super::*;

impl Lowerer<'_> {
    pub(super) fn parameter_type(&mut self, node: Node, ty: Type) -> Result<Type, String> {
        if node.question_token().is_nil() && node.initializer().is_nil() {
            return Ok(ty);
        }
        let mut arms = match ty {
            Type::Union { union_id } => self.unions[union_id].arms.clone(),
            _ => vec![ty],
        };
        arms.push(Type::Undefined);
        self.intern_union(arms).ok_or_else(|| {
            self.refuse(
                node,
                "optional parameter has no native union representation",
            )
        })
    }

    fn undefined_tag(&self, ty: &Type) -> Option<(usize, usize)> {
        let Type::Union { union_id } = ty else {
            return None;
        };
        self.unions[*union_id]
            .arms
            .iter()
            .position(|a| *a == Type::Undefined)
            .map(|tag| (*union_id, tag))
    }

    pub(super) fn call_arguments(
        &mut self,
        node: Node,
        types: &[Type],
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, false)
    }

    pub(super) fn method_arguments(
        &mut self,
        node: Node,
        types: &[Type],
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, true)
    }

    fn call_arguments_in(
        &mut self,
        node: Node,
        types: &[Type],
        preserve_values: bool,
    ) -> Result<Vec<Expr>, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > types.len() {
            return Err(self.refuse(node, "extra native call arguments are not ported"));
        }
        types
            .iter()
            .enumerate()
            .map(|(index, ty)| {
                if let Some(arg) = arguments.get(index) {
                    if preserve_values
                        && *ty == Type::Dyn
                        && matches!(
                            arg.kind(),
                            SyntaxKind::ObjectLiteralExpression
                                | SyntaxKind::ArrayLiteralExpression
                        )
                        && let Ok(layout @ (Type::Record { .. } | Type::Array { .. })) =
                            self.ty(*arg)
                    {
                        let value = self.expected_expression(*arg, layout)?;
                        return self.coerce(value, Type::Dyn, *arg);
                    }
                    self.expected_expression(*arg, ty.clone())
                } else if *ty == Type::Dyn || self.undefined_tag(ty).is_some() {
                    self.coerce(
                        Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(node),
                        },
                        ty.clone(),
                        node,
                    )
                } else {
                    Err(self.refuse(
                        node,
                        "missing argument has no native undefined representation",
                    ))
                }
            })
            .collect()
    }

    pub(super) fn bind_parameter(
        &mut self,
        node: Option<Node>,
        param: &Param,
    ) -> Result<Vec<Stmt>, String> {
        let local = Local {
            id: param.local_id.clone(),
            name: param.name.clone(),
            r#type: param.r#type.clone(),
            mutable: true,
            boxed: false,
        };
        self.locals.push(local.clone());
        let Some(node) = node else { return Ok(vec![]) };
        let symbol = self.symbol(node.name());
        if param.r#type == Type::Dyn && !node.initializer().is_nil() {
            let value = self.expected_expression(node.initializer(), Type::Dyn)?;
            self.bindings.insert(symbol, local.clone());
            return Ok(vec![Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(Expr::VarRef {
                        local_id: local.id.clone(),
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    }),
                    test: "undefined".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                then: vec![Stmt::Assign {
                    local_id: local.id,
                    initializes_global: false,
                    value,
                    loc: self.loc(node),
                }],
                else_: None,
                loc: self.loc(node),
            }]);
        }

        let Some((union_id, tag)) = self
            .undefined_tag(&param.r#type)
            .filter(|_| !node.initializer().is_nil())
        else {
            self.bindings.insert(symbol, local);
            return Ok(vec![]);
        };
        let arms = self.unions[union_id]
            .arms
            .iter()
            .filter(|a| **a != Type::Undefined)
            .cloned()
            .collect::<Vec<_>>();
        let target = self
            .intern_union(arms.clone())
            .ok_or_else(|| self.refuse(node, "default parameter body type is not ported"))?;
        if matches!(target, Type::Null | Type::Undefined) {
            return Err(self.refuse(node, "default parameter needs a non-unit body type"));
        }
        // Bind only after lowering the initializer: earlier parameters are visible;
        // self/later parameters and body declarations remain in their TDZ.
        let default = self.expected_expression(node.initializer(), target.clone())?;
        let value = || Expr::VarRef {
            local_id: local.id.clone(),
            r#type: param.r#type.clone(),
            loc: self.loc(node),
        };
        // Projection only reads the immutable incoming slot. Never duplicate a
        // source expression with side effects when translating union tags.
        let mut supplied = None;
        for arm in arms {
            let arm_tag = self.unions[union_id]
                .arms
                .iter()
                .position(|a| *a == arm)
                .unwrap();
            let narrowed = if arm == Type::Null {
                Expr::UnitLit {
                    unit: "null",
                    r#type: Type::Null,
                    loc: self.loc(node),
                }
            } else {
                Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: arm_tag,
                    value: Box::new(value()),
                    r#type: arm,
                    loc: self.loc(node),
                }
            };
            let narrowed = self.coerce(narrowed, target.clone(), node)?;
            supplied = Some(match supplied {
                None => narrowed,
                Some(previous) => Expr::Ternary {
                    cond: Box::new(Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag: arm_tag,
                        negated: false,
                        value: Box::new(value()),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    then: Box::new(narrowed),
                    else_: Box::new(previous),
                    r#type: target.clone(),
                    loc: self.loc(node),
                },
            });
        }
        let init = Expr::Ternary {
            cond: Box::new(Expr::UnionIsTag {
                union_id: format!("u{union_id}"),
                tag,
                negated: false,
                value: Box::new(value()),
                r#type: Type::Bool,
                loc: self.loc(node),
            }),
            then: Box::new(default),
            else_: Box::new(supplied.expect("nonempty default type")),
            r#type: target.clone(),
            loc: self.loc(node),
        };
        let binding = Local {
            id: format!("v{}", self.locals.len()),
            name: param.name.clone(),
            r#type: target,
            mutable: true,
            boxed: false,
        };
        self.locals.push(binding.clone());
        self.bindings.insert(symbol, binding.clone());
        Ok(vec![Stmt::VarDecl {
            local_id: binding.id,
            init,
            loc: self.loc(node),
        }])
    }
}
