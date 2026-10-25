//! Fixed native call slots; omission is an undefined tag, defaults run in the callee.
use super::*;

pub(super) fn erased_rest(ty: &Type) -> bool {
    matches!(ty, Type::Func { rest: true, params, .. }
        if matches!(params.as_slice(), [Type::Array { elem }] if **elem == Type::Dyn))
}

impl Lowerer<'_> {
    /// Unpack a public (...args: any[]) contract without changing callable
    /// identity or exposing its transport vector as a source parameter.
    pub(super) fn bind_erased_rest_formals(
        &mut self,
        nodes: &[Node],
        incoming: &Param,
    ) -> Result<Vec<Stmt>, String> {
        let mut body = Vec::new();
        for (index, node) in nodes.iter().copied().enumerate() {
            let loc = self.loc(node);
            let read = || Expr::VarRef {
                local_id: incoming.local_id.clone(),
                r#type: incoming.r#type.clone(),
                loc: loc.clone(),
            };
            let offset = || Expr::NumLit {
                value: index as f64,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            };
            let value = Expr::Ternary {
                cond: Box::new(Expr::Bin {
                    op: "<".into(),
                    left: Box::new(offset()),
                    right: Box::new(Expr::ArrayIntrinsic {
                        method: "length".into(),
                        receiver: Box::new(read()),
                        args: vec![],
                        r#type: Type::F64,
                        loc: loc.clone(),
                    }),
                    r#type: Type::Bool,
                    loc: loc.clone(),
                }),
                then: Box::new(Expr::ArrayGet {
                    arr: Box::new(read()),
                    index: Box::new(offset()),
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                }),
                else_: Box::new(self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: loc.clone(),
                    },
                    Type::Dyn,
                    node,
                )?),
                r#type: Type::Dyn,
                loc: loc.clone(),
            };
            let formal = Param {
                local_id: format!("v{}", self.locals.len()),
                name: node.name().text().into(),
                r#type: Type::Dyn,
            };
            // Incoming values must exist before the default reads the slot.
            body.push(Stmt::VarDecl {
                local_id: formal.local_id.clone(),
                init: value,
                loc,
            });
            body.extend(self.bind_parameter(Some(node), &formal)?);
            // JS annotations do not prove that an omitted public argument is
            // present. Keep its live value for tests, defaults and captures.
            let symbol = self.symbol(node.name());
            self.var_types.insert(symbol, Type::Dyn);
            self.var_defined.remove(&symbol);
        }
        Ok(body)
    }

    pub(super) fn parameter_type(&mut self, node: Node, ty: Type) -> Result<Type, String> {
        let symbol = self.symbol(node.name());
        if node.question_token().is_nil()
            && node.initializer().is_nil()
            && !(self.js_absence_parameters.contains(&symbol)
                && matches!(ty, Type::String | Type::F64 | Type::Bool))
        {
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
        self.call_arguments_in(node, types, false, false)
    }

    pub(super) fn rest_call_arguments(
        &mut self,
        node: Node,
        types: &[Type],
        rest: bool,
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, false, rest)
    }

    pub(super) fn method_arguments(
        &mut self,
        node: Node,
        types: &[Type],
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, true, false)
    }

    fn call_arguments_in(
        &mut self,
        node: Node,
        types: &[Type],
        preserve_values: bool,
        rest: bool,
    ) -> Result<Vec<Expr>, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "iterable call spreads are not ported"));
        }
        if !rest && arguments.len() > types.len() {
            return Err(self.refuse(node, "extra native call arguments are not ported"));
        }
        types
            .iter()
            .enumerate()
            .map(|(index, ty)| {
                if rest && index + 1 == types.len() {
                    let Type::Array { elem } = ty else {
                        return Err(self.refuse(node, "rest ABI needs a trailing native array"));
                    };
                    let elems = arguments
                        .iter()
                        .skip(index)
                        .map(|arg| self.expected_expression(*arg, (**elem).clone()))
                        .collect::<Result<Vec<_>, _>>()?;
                    return Ok(Expr::ArrayLit {
                        elems,
                        r#type: ty.clone(),
                        loc: self.loc(node),
                    });
                }
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
            if parameter_abi::is_javascript(node) && self.optional_storage(&local.r#type) {
                let source = self.checker.get_type_at_location(node.name());
                if !self.source_has_undefined(source) {
                    // A planned/contextual input can be wider than its JS
                    // annotation. Read its live tags until a presence test.
                    self.var_types.insert(symbol, local.r#type.clone());
                    self.var_defined.remove(&symbol);
                }
            }
            self.bindings.insert(symbol, local);
            return Ok(vec![]);
        };
        let arms = self.unions[union_id]
            .arms
            .iter()
            .filter(|a| **a != Type::Undefined)
            .cloned()
            .collect::<Vec<_>>();
        // Lower exactly once against the complete call contract. Native builtin
        // result types can be wider than the checker declaration's default type.
        let default = self.expected_expression(node.initializer(), param.r#type.clone())?;
        let maybe_undefined = self.default_may_be_undefined(&default);
        let target = if maybe_undefined {
            param.r#type.clone()
        } else {
            self.intern_union(arms.clone())
                .ok_or_else(|| self.refuse(node, "default parameter body type is not ported"))?
        };
        if matches!(target, Type::Null | Type::Undefined) {
            return Err(self.refuse(node, "default parameter needs a non-unit body type"));
        }
        // Bind only after lowering the initializer: earlier parameters are visible;
        // self/later parameters and body declarations remain in their TDZ.
        let default = if maybe_undefined {
            default
        } else {
            self.project_defined_default(default, target.clone(), node)?
        };
        let value = || Expr::VarRef {
            local_id: local.id.clone(),
            r#type: param.r#type.clone(),
            loc: self.loc(node),
        };
        // Projection only reads the immutable incoming slot. Never duplicate a
        // source expression with side effects when translating union tags.
        let mut supplied = if maybe_undefined { Some(value()) } else { None };
        for arm in arms.into_iter().filter(|_| !maybe_undefined) {
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
        if maybe_undefined {
            // Preserve native uncertainty across reads/captures until a live
            // presence test or assignment establishes a defined value.
            self.var_types.insert(symbol, binding.r#type.clone());
            self.var_defined.remove(&symbol);
        }
        Ok(vec![Stmt::VarDecl {
            local_id: binding.id,
            init,
            loc: self.loc(node),
        }])
    }
    fn project_defined_default(
        &self,
        value: Expr,
        target: Type,
        node: Node,
    ) -> Result<Expr, String> {
        Ok(match value {
            Expr::UnionWrap { value, .. } => self.coerce(*value, target, node)?,
            Expr::Sequence {
                stmts, result, loc, ..
            } => Expr::Sequence {
                stmts,
                result: Box::new(self.project_defined_default(*result, target.clone(), node)?),
                r#type: target,
                loc,
            },
            Expr::Ternary {
                cond,
                then,
                else_,
                loc,
                ..
            } => Expr::Ternary {
                cond,
                then: Box::new(self.project_defined_default(*then, target.clone(), node)?),
                else_: Box::new(self.project_defined_default(*else_, target.clone(), node)?),
                r#type: target,
                loc,
            },
            value => self.coerce(value, target, node)?,
        })
    }

    fn default_may_be_undefined(&self, value: &Expr) -> bool {
        match value {
            Expr::UnionWrap { value, .. } => self.default_may_be_undefined(value),
            Expr::Sequence { result, .. } => self.default_may_be_undefined(result),
            Expr::Ternary { then, else_, .. } => {
                self.default_may_be_undefined(then) || self.default_may_be_undefined(else_)
            }
            _ => self.default_type_may_be_undefined(&value.ty()),
        }
    }

    fn default_type_may_be_undefined(&self, ty: &Type) -> bool {
        match ty {
            Type::Undefined | Type::Dyn => true,
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .any(|arm| self.default_type_may_be_undefined(arm)),
            _ => false,
        }
    }
}
