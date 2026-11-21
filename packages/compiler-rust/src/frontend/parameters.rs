//! Fixed native call slots; omission is an undefined tag, defaults run in the callee.
use super::*;

pub(super) fn erased_rest(ty: &Type) -> bool {
    matches!(ty, Type::Func { rest: true, params, .. }
        if matches!(params.as_slice(), [Type::Array { elem }] if **elem == Type::Dyn))
}

#[cfg(test)]
mod tests {
    #[test]
    fn generic_rest_with_unrepresentable_collection_remains_refused() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/generic-rest-pick");
                for name in ["weak-map.ts", "set-inspection.ts"] {
                    let input = std::fs::canonicalize(root.join(name)).unwrap();
                    let work = tempfile::Builder::new()
                        .prefix("scriptc-generic-rest-")
                        .tempdir()
                        .unwrap();
                    let error = match crate::frontend::lower(&input, work.path(), None, false) {
                        Ok(_) => panic!("{name}: generic rest must not silently erase collections"),
                        Err(error) => error,
                    };
                    assert!(
                        error.contains("generic source rest parameters"),
                        "{name}: {error}"
                    );
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

pub(super) fn arguments_reference(function: Node) -> Option<Node> {
    arguments_reference_except(function, Node::NIL)
}

/// The first `arguments` reference in `function` other than `skip`.
pub(super) fn arguments_reference_except(function: Node, skip: Node) -> Option<Node> {
    fn visit(node: Node, skip: Node, found: &mut Option<Node>) {
        if found.is_some() {
            return;
        }
        node.for_each_child(&mut |child: Node| {
            // Property names spelled `arguments` (`call.arguments`,
            // `{ arguments: value }`, member and binding property names) are
            // not references to the function's arguments object. Shorthand
            // `{ arguments }` still reads the binding and keeps counting.
            let property_name = child.kind() == SyntaxKind::Identifier
                && match node.kind() {
                    SyntaxKind::PropertyAccessExpression
                    | SyntaxKind::PropertyAssignment
                    | SyntaxKind::PropertyDeclaration
                    | SyntaxKind::PropertySignature
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::MethodSignature
                    | SyntaxKind::GetAccessor
                    | SyntaxKind::SetAccessor
                    | SyntaxKind::EnumMember => node.name() == child,
                    SyntaxKind::BindingElement => node.property_name() == child,
                    SyntaxKind::QualifiedName => node.right() == child,
                    _ => false,
                };
            if child.kind() == SyntaxKind::Identifier
                && child.text() == "arguments"
                && !property_name
                && child != skip
            {
                *found = Some(child);
                return true;
            }
            // Arrow functions inherit the surrounding arguments object;
            // ordinary nested functions and classes own a different one.
            if !matches!(
                child.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::Constructor
                    | SyntaxKind::GetAccessor
                    | SyntaxKind::SetAccessor
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::ClassExpression
            ) {
                visit(child, skip, found);
            }
            found.is_some()
        });
    }
    let mut found = None;
    if !function.body().is_nil() {
        visit(function.body(), skip, &mut found);
    }
    found
}

impl Lowerer<'_> {
    pub(super) fn parameter_symbol(&mut self, node: Node) -> u32 {
        if node.is_nil() || node.name().is_nil() {
            return 0;
        }
        let parent = node.parent();
        if !parent.is_nil()
            && parent.kind() == SyntaxKind::Constructor
            && classes::parameter_property(node)
        {
            // The declaration-name symbol denotes the instance property; bare
            // references in defaults and the constructor body denote a local.
            self.checker
                .get_symbols_of_parameter_property_declaration(node, node.name().text())
                .0
                .0
        } else {
            self.symbol(node.name())
        }
    }

    /// Unpack a public rest contract without changing callable identity or
    /// exposing its transport vector as a source parameter. Typed rest
    /// elements are boxed for ordinary JavaScript formals; an omitted formal
    /// remains the JavaScript `undefined` value rather than inventing a native
    /// scalar default.
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
            if !node.dot_dot_dot_token().is_nil() {
                let ty = incoming.r#type.clone();
                let formal = Param {
                    local_id: format!("v{}", self.locals.len()),
                    name: node.name().text().into(),
                    r#type: ty.clone(),
                };
                body.push(Stmt::VarDecl {
                    local_id: formal.local_id.clone(),
                    init: Expr::ArrayIntrinsic {
                        method: "slice".into(),
                        receiver: Box::new(read()),
                        args: vec![offset()],
                        r#type: ty,
                        loc: loc.clone(),
                    },
                    loc,
                });
                body.extend(self.bind_parameter(Some(node), &formal)?);
                continue;
            }
            let Type::Array { elem } = &incoming.r#type else {
                unreachable!("validated rest transport")
            };
            let present = Expr::ArrayGet {
                arr: Box::new(read()),
                index: Box::new(offset()),
                r#type: (**elem).clone(),
                loc: loc.clone(),
            };
            let present = if **elem == Type::Dyn {
                present
            } else {
                self.coerce(present, Type::Dyn, node)?
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
                then: Box::new(present),
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
            if node.name().kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(node.name());
                self.var_types.insert(symbol, Type::Dyn);
                self.var_defined.remove(&symbol);
            }
        }
        Ok(body)
    }

    pub(super) fn parameter_type(&mut self, node: Node, ty: Type) -> Result<Type, String> {
        let symbol = self.parameter_symbol(node);
        if self.data_bindings.contains(&symbol) {
            return Ok(Type::Dyn);
        }
        if parameter_abi::is_javascript(node)
            && !node.initializer().is_nil()
            && node.initializer().kind() == SyntaxKind::NullKeyword
            && matches!(ty, Type::Null | Type::Undefined)
        {
            // In checked JavaScript a null default does not declare a
            // null-only public ABI. It is the conventional sentinel for an
            // otherwise unannotated value (for example an optional event
            // name), so retain the owning dynamic argument contract.
            return Ok(Type::Dyn);
        }
        if node.question_token().is_nil()
            && node.initializer().is_nil()
            && !self.js_absence_parameters.contains(&symbol)
        {
            return Ok(ty);
        }
        let mut arms = match ty {
            Type::Union { union_id } => self.unions[union_id].arms.clone(),
            _ => vec![ty],
        };
        if self.js_null_parameters.contains(&symbol) {
            arms.push(Type::Null);
        }
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

    #[track_caller]
    pub(super) fn call_arguments(
        &mut self,
        node: Node,
        types: &[Type],
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, false, false)
    }

    #[track_caller]
    pub(super) fn rest_call_arguments(
        &mut self,
        node: Node,
        types: &[Type],
        rest: bool,
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, false, rest)
    }

    #[track_caller]
    pub(super) fn method_arguments(
        &mut self,
        node: Node,
        types: &[Type],
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, true, false)
    }

    #[track_caller]
    pub(super) fn rest_method_arguments(
        &mut self,
        node: Node,
        types: &[Type],
        rest: bool,
    ) -> Result<Vec<Expr>, String> {
        self.call_arguments_in(node, types, true, rest)
    }

    #[track_caller]
    fn call_arguments_in(
        &mut self,
        node: Node,
        types: &[Type],
        preserve_values: bool,
        rest: bool,
    ) -> Result<Vec<Expr>, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let first_spread = arguments
            .iter()
            .position(|arg| arg.kind() == SyntaxKind::SpreadElement);
        if let Some(index) = first_spread {
            if !rest {
                if index == 0
                    && arguments.len() == 1
                    && arguments[0].expression().kind() == SyntaxKind::Identifier
                {
                    let source = self.expression(arguments[0].expression())?;
                    if matches!(&source.ty(), Type::Array { elem } if **elem == Type::Dyn) {
                        return types
                            .iter()
                            .enumerate()
                            .map(|(position, ty)| {
                                let value = Expr::ArrayGet {
                                    arr: Box::new(source.clone()),
                                    index: Box::new(Expr::NumLit {
                                        value: position as f64,
                                        spelling: None,
                                        r#type: Type::F64,
                                        loc: self.loc(node),
                                    }),
                                    r#type: Type::Dyn,
                                    loc: self.loc(node),
                                };
                                self.coerce(value, ty.clone(), node)
                            })
                            .collect();
                    }
                }
                return Err(self.refuse(node, "iterable call spreads are not ported"));
            }
            if types.is_empty() || index < types.len() - 1 {
                return Err(
                    self.refuse(node, "call spreads before fixed parameters are not ported")
                );
            }
        }
        if !rest && arguments.len() > types.len() {
            return Err(self.refuse(
                node,
                &format!(
                    "extra native call arguments are not ported ({} supplied for {} ABI slots; preserve_values={preserve_values})",
                    arguments.len(),
                    types.len()
                ),
            ));
        }
        let target = node.expression();
        let checked_target = self.checker.get_type_at_location(target);
        let checked_arities = self
            .checker
            .get_signatures_of_type(
                checked_target,
                source_frontend::prelude::SignatureKind::CALL,
            )
            .into_iter()
            .map(|signature| self.checker.sig(signature).parameters.len())
            .collect::<Vec<_>>();
        let argument_caller = std::panic::Location::caller();
        let (member_name, receiver_detail) = if target.kind()
            == SyntaxKind::PropertyAccessExpression
        {
            let receiver = target.expression();
            let symbol = self.symbol(receiver);
            let binding = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|local| local.r#type.clone());
            let projection = self
                .projections
                .get(&declarations::Key::of(receiver))
                .cloned();
            (
                target.name().text().to_string(),
                format!(
                    "receiver={:?}/{:?}, symbol={symbol}, binding={binding:?}, projection={projection:?}",
                    receiver.kind(),
                    receiver.text(),
                ),
            )
        } else {
            (String::new(), "no property receiver".to_string())
        };
        types
            .iter()
            .enumerate()
            .map(|(index, ty)| {
                if rest && index + 1 == types.len() {
                    let Type::Array { elem } = ty else {
                        return Err(self.refuse(node, "rest ABI needs a trailing native array"));
                    };
                    if first_spread.is_some() {
                        return self.array_spread_elements(
                            node,
                            arguments.iter().skip(index).copied().collect(),
                            ty.clone(),
                        );
                    }
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
                    self.expected_call_argument(*arg, ty.clone(), preserve_values)
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
                    let message = format!(
                            "missing argument {index} has no native undefined representation for {}; call node {:?}, target {:?}/{:?}.{:?}, checker type {:?}, checker call arities {:?}; {}; argument ABI requested at {}:{}:{}",
                            self.contextual_type_description(ty),
                            node.kind(),
                            target.kind(),
                            target.text(),
                            member_name,
                            checked_target,
                            checked_arities,
                            receiver_detail,
                            argument_caller.file(),
                            argument_caller.line(),
                            argument_caller.column(),
                        );
                    Err(self.refuse(node, &message))
                }
            })
            .collect()
    }

    pub(super) fn expected_call_argument(
        &mut self,
        argument: Node,
        ty: Type,
        preserve_value: bool,
    ) -> Result<Expr, String> {
        if preserve_value
            && ty == Type::Dyn
            && matches!(
                argument.kind(),
                SyntaxKind::ObjectLiteralExpression | SyntaxKind::ArrayLiteralExpression
            )
            && let Ok(layout @ (Type::Record { .. } | Type::Array { .. })) = self.ty(argument)
        {
            let value = self.expected_expression(argument, layout)?;
            return self.coerce(value, Type::Dyn, argument);
        }
        self.expected_expression(argument, ty)
    }

    pub(super) fn bind_parameter(
        &mut self,
        node: Option<Node>,
        param: &Param,
    ) -> Result<Vec<Stmt>, String> {
        if let Some(node) = node
            && node.name().kind() == SyntaxKind::ArrayBindingPattern
        {
            self.validate_array_parameter(node)?;
            let mut body = self.bind_parameter(None, param)?;
            let incoming = self.locals.last().unwrap().clone();
            body.extend(self.bind_sequence_pattern(
                node.name(),
                self.construction_read(&incoming, node),
                true,
                false,
                None,
            )?);
            return Ok(body);
        }
        if let Some(node) = node
            && node.name().kind() == SyntaxKind::ObjectBindingPattern
        {
            return self.bind_object_parameter(node, param);
        }
        let local = Local {
            id: param.local_id.clone(),
            name: param.name.clone(),
            r#type: param.r#type.clone(),
            mutable: true,
            boxed: false,
        };
        self.locals.push(local.clone());
        let Some(node) = node else { return Ok(vec![]) };
        let symbol = self.parameter_symbol(node);
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
            if self.optional_storage(&local.r#type) {
                let source = self.checker.get_type_at_location(node.name());
                if !self.source_has_undefined(source) {
                    // A planned/contextual input can be wider than its source
                    // annotation. This also occurs in TypeScript because
                    // method parameters are bivariant: the emitted JavaScript
                    // still receives `undefined` through an optional public
                    // view. Read the live tags until a presence test instead
                    // of projecting the checker's narrower static type.
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
        let default = self
            .expected_expression(node.initializer(), param.r#type.clone())
            .map_err(|error| {
                format!(
                    "{error}; while lowering default for parameter {:?} with ABI {}",
                    node.name().text(),
                    self.contextual_type_description(&param.r#type)
                )
            })?;
        let source = self.checker.get_type_at_location(node.initializer());
        let source_flags = self.checker.ty(source).flags;
        // Contextual lowering uses the whole public parameter union, so a
        // definitely-present default can acquire an artificial undefined arm
        // in the IR.  The source type remains the authority here: default
        // initializers only run for an omitted/undefined argument, and a
        // non-any expression whose type excludes undefined produces the
        // defined local binding used by the function body.
        let source_proves_defined = !source_flags.intersects(TypeFlags::ANY | TypeFlags::UNKNOWN)
            && !self.source_has_undefined(source);
        let initializer = node.initializer();
        let native_tty = initializer.kind() == SyntaxKind::PropertyAccessExpression
            && initializer.name().text() == "isTTY"
            && ["stdin", "stdout", "stderr"]
                .iter()
                .any(|stream| self.process_member(initializer.expression(), stream));
        let maybe_undefined =
            self.default_may_be_undefined(&default) && (!source_proves_defined || native_tty);
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
