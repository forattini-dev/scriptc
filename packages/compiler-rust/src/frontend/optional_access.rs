//! Optional member chains keep their receiver cells and lazy keys in the IR.
use super::*;

pub(super) fn is_access(node: Node) -> bool {
    node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        && matches!(
            node.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn optional_class_accessor_call_is_still_refused() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let input = std::fs::canonicalize(
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../tests/fixtures/optional-class-callback/getter.ts"),
                )
                .unwrap();
                let work = tempfile::Builder::new()
                    .prefix("scriptc-optional-getter-")
                    .tempdir()
                    .unwrap();
                let error = match crate::frontend::lower(&input, work.path(), None, false) {
                    Ok(_) => panic!("optional accessor calls need a single live getter read"),
                    Err(error) => error,
                };
                assert!(error.contains("optional call onEvict requires"), "{error}");
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

impl Lowerer<'_> {
    pub(super) fn live_member_receiver(&mut self, node: Node, value: Expr) -> Expr {
        let source_node = receivers::reference_node(node);
        let tracked_symbol = if source_node.kind() == SyntaxKind::Identifier {
            self.symbol(source_node)
        } else {
            0
        };
        if self.var_defined.contains(&tracked_symbol) {
            // Retain a live presence proof for a tracked local. Calls and
            // writes invalidate these facts before the next receiver read.
            return value;
        }
        if tracked_symbol != 0
            && let Expr::DynCheck { value: source, .. } = &value
            && matches!(
                source.as_ref(),
                Expr::VarRef {
                    r#type: Type::Dyn,
                    ..
                }
            )
        {
            let id = self
                .checker
                .get_type_of_symbol(source_frontend::prelude::SymbolId(tracked_symbol));
            let checked = self.checker.ty(id);
            let nullable = checked
                .flags
                .intersects(TypeFlags::NULL | TypeFlags::UNDEFINED | TypeFlags::VOID)
                || checked.flags.intersects(TypeFlags::UNION)
                    && checked.types().iter().any(|arm| {
                        self.checker
                            .ty(*arm)
                            .flags
                            .intersects(TypeFlags::NULL | TypeFlags::UNDEFINED | TypeFlags::VOID)
                    });
            if nullable || self.absence_assignments.contains(&tracked_symbol) {
                // A call may invalidate a checker narrowing of a mutable
                // binding. Property access must inspect the live nullish tag
                // rather than fail a generic DynCheck before forming the JS
                // property reference.
                return source.as_ref().clone();
            }
        }
        if let Expr::DynCheck { value: source, .. } = &value
            && matches!(source.as_ref(), Expr::DynKeyGet { value: receiver, .. } if !matches!(receiver.as_ref(), Expr::DynFrom { .. }))
        {
            // A data slot can be retagged through another owning alias. Member
            // lookup observes its current value, not a scalar checker guess.
            // A boxed typed container still owns its element contract (for
            // example a represented regex capture); retain that checked view.
            return source.as_ref().clone();
        }
        if let Expr::UnionNarrow { value: source, .. } = &value
            && (self.array_view(&source.ty())
                || self.string_view(&source.ty())
                || self.nullable_record(&source.ty()).is_some())
        {
            // A checker refinement can outlive an alias/callback mutation.
            // Keep the actual nullable receiver for the property read.
            return source.as_ref().clone();
        }
        value
    }

    pub(super) fn optional_result_type(&mut self, value: Type, node: Node) -> Result<Type, String> {
        if self.bytes_named_key_value(node, &mut HashSet::new()) {
            return Ok(Type::Dyn);
        }
        if matches!(value, Type::Null | Type::Undefined) {
            // Unit tags never occupy standalone ABI slots.
            return self.undefined_storage_type(Type::F64, node);
        }
        self.undefined_storage_type(value, node)
    }

    pub(super) fn optional_access(&mut self, node: Node) -> Result<Expr, String> {
        if node.kind() == SyntaxKind::CallExpression
            && let Some(value) = self.bun_child_call(node)?
        {
            // Bun's optional stdin calls have a native absent-pipe contract:
            // end is a no-op and write reports false. Lower the complete AST
            // before the generic chain decomposes `stdin` into a Bool view.
            return Ok(value);
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.parent().kind() == SyntaxKind::ExpressionStatement
            && node.arguments().is_empty()
        {
            let member = node.expression();
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && member.name().text() == "end"
                && !member.question_dot_token().is_nil()
                && let Some(value) = self.child_stdin_call(node, true)?
            {
                // The represented Node child stdin closes its pipe if present
                // and is a no-op when stdio made it null. This shortcut is
                // limited to a discarded result: Writable.end() itself returns
                // the stream, whereas the existing native close ABI is void.
                return Ok(value);
            }
        }
        let mut steps = Vec::new();
        let mut base = node;
        loop {
            if is_access(base) {
                steps.push(base);
                base = base.expression();
            } else if base.kind() == SyntaxKind::CallExpression
                && base.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
            {
                let member = base.expression();
                if !matches!(
                    member.kind(),
                    SyntaxKind::Identifier
                        | SyntaxKind::PropertyAccessExpression
                        | SyntaxKind::ElementAccessExpression
                ) {
                    return Err(self.refuse(
                        base,
                        "optional calls require a native receiver-call contract",
                    ));
                }
                steps.push(base);
                base = if member.kind() == SyntaxKind::Identifier {
                    member
                } else {
                    member.expression()
                };
            } else {
                break;
            }
        }
        steps.reverse();
        // Presence observes the live cell. Checker refinements can survive a
        // call which changes a captured/module binding to undefined.
        let value = self.condition_value(primitives::primitive_source(base))?;
        let value = match value {
            Expr::UnionNarrow { ref value, .. } if matches!(value.ty(), Type::Union { union_id } if self.unions[union_id].arms.iter().any(|arm| matches!(arm, Type::Null | Type::Undefined))) =>
            {
                // A data-field read may carry the same stale checker
                // refinement as an identifier. Test its original owning slot.
                value.as_ref().clone()
            }
            value => value,
        };
        self.optional_steps(value, &steps)
    }

    fn optional_steps(&mut self, value: Expr, steps: &[Node]) -> Result<Expr, String> {
        let Some((&node, rest)) = steps.split_first() else {
            return Ok(value);
        };
        let call = node.kind() == SyntaxKind::CallExpression;
        let optional = if call {
            !node.question_dot_token().is_nil() || !node.expression().question_dot_token().is_nil()
        } else {
            !node.question_dot_token().is_nil()
        };
        let known_nullish = matches!(value.ty(), Type::Null | Type::Undefined);
        if optional && known_nullish {
            let result_type = self.optional_result_type(Type::Undefined, node)?;
            let result = self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                result_type.clone(),
                node,
            )?;
            // Preserve a receiver's effects even when its result is statically
            // nullish. The complete remaining chain is skipped in this branch.
            return Ok(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: self.coerce(value, Type::Dyn, node)?,
                    loc: self.loc(node),
                }],
                result: Box::new(result),
                r#type: result_type,
                loc: self.loc(node),
            });
        }
        let local = Local {
            id: format!("optional{}", self.locals.len()),
            name: "optional receiver".into(),
            r#type: value.ty(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(local.clone());
        let read = || Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        };
        let (present, nullish) = self.optional_receiver(read(), node)?;
        let read_value = read();
        let before = self.var_defined.clone();
        let operation = if call {
            self.optional_native_call(
                node,
                present,
                read_value,
                optional,
                !node.question_dot_token().is_nil(),
                nullish.is_some(),
            )?
        } else if !optional && nullish.is_some() {
            // A non-optional continuation still evaluates its key and throws on
            // an absent value. Only a preceding ?. can skip the whole tail.
            let result_type = self.optional_member_type(node, &present.ty())?;
            let key = self.optional_key(node)?;
            let receiver = self.coerce(read_value, Type::Dyn, node)?;
            let value = self.dynamic_get(node, receiver, key);
            self.coerce(value, result_type, node)?
        } else {
            self.optional_member(node, present)?
        };
        let tail = self.optional_steps(operation, rest)?;
        let result = if optional && let Some(cond) = nullish {
            self.var_defined = before.intersection(&self.var_defined).copied().collect();
            let tail = if tail.ty() == Type::Void {
                Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: tail,
                        loc: self.loc(node),
                    }],
                    result: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                }
            } else {
                tail
            };
            let result_type = self.optional_result_type(tail.ty(), node)?;
            let undefined = self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                },
                result_type.clone(),
                node,
            )?;
            let tail = if tail.ty() != result_type && matches!(tail.ty(), Type::Union { .. }) {
                let value = self.coerce(tail, Type::Dyn, node)?;
                self.coerce(value, result_type.clone(), node)?
            } else {
                self.coerce(tail, result_type.clone(), node)?
            };
            Expr::Ternary {
                cond: Box::new(cond),
                then: Box::new(undefined),
                else_: Box::new(tail),
                r#type: result_type,
                loc: self.loc(node),
            }
        } else {
            tail
        };
        let ty = result.ty();
        Ok(Expr::Sequence {
            stmts: vec![Stmt::VarDecl {
                local_id: local.id,
                init: value,
                loc: self.loc(node),
            }],
            result: Box::new(result),
            r#type: ty,
            loc: self.loc(node),
        })
    }

    fn optional_native_call(
        &mut self,
        node: Node,
        present: Expr,
        original: Expr,
        optional: bool,
        optional_call: bool,
        nullable: bool,
    ) -> Result<Expr, String> {
        let member = node.expression();
        if member.kind() == SyntaxKind::Identifier {
            if !optional_call {
                return Err(self.refuse(node, "direct optional call lost its optional-call marker"));
            }
            let callee = self.callable_body(present, node)?;
            if callee.ty() == Type::Dyn {
                // optional_receiver has already guarded the nullish branch.
                // Multiple present callable arms keep their selected closure
                // in NativeValue, so dispatch them through the native dynamic
                // call ABI without evaluating arguments on the skipped path.
                let source_arguments = node.arguments().into_iter().collect::<Vec<_>>();
                if source_arguments
                    .iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                {
                    let argument_type = Type::Array {
                        elem: Box::new(Type::Dyn),
                    };
                    let args = self.array_spread_elements(node, source_arguments, argument_type)?;
                    return Ok(Expr::LibCall {
                        r#fn: "dyn.callSpread".into(),
                        args: vec![callee, args],
                        r#type: Type::Dyn,
                        loc: self.loc(node),
                    });
                }
                let args = source_arguments
                    .into_iter()
                    .map(|argument| self.expected_expression(argument, Type::Dyn))
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(Expr::DynCall {
                    callee: Box::new(callee),
                    callee_name: member.text().into(),
                    args,
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
            let Type::Func { params, ret, rest } = callee.ty() else {
                return Err(self.refuse(
                    node,
                    "direct optional call requires one represented callable arm",
                ));
            };
            let args = self.rest_call_arguments(node, &params, rest)?;
            return Ok(Expr::CallValue {
                callee: Box::new(callee),
                args,
                r#type: *ret,
                loc: self.loc(node),
            });
        }
        if member.kind() == SyntaxKind::ElementAccessExpression {
            let key = primitives::primitive_source(member.argument_expression());
            let operation = if key.kind() == SyntaxKind::PropertyAccessExpression
                && self.standard_symbol(key.expression())
            {
                let operation = format!("sym.{}", key.name().text());
                ir::well_known_symbol(&operation).map(|_| operation)
            } else {
                None
            }
            .ok_or_else(|| {
                self.refuse(
                    member,
                    "computed optional calls require an exact well-known Symbol key",
                )
            })?;
            let receiver = if nullable && !optional {
                original
            } else {
                present
            };
            let receiver = self.coerce(receiver, Type::Dyn, node)?;
            let args = node
                .arguments()
                .into_iter()
                .map(|argument| self.expected_expression(argument, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Expr::DynInvoke {
                recv: Box::new(receiver),
                method: format!("\0{operation}"),
                callee_name: operation.replacen("sym.", "Symbol.", 1),
                optional: optional_call,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let method = member.name().text();
        let checked_receiver = self.ty(member.expression()).ok();
        let checked_bytes_receiver = if method == "toString" {
            let checked_receiver_id = self.checker.get_type_at_location(member.expression());
            let checked_receiver_arms = if self
                .checker
                .ty(checked_receiver_id)
                .flags
                .intersects(TypeFlags::UNION)
            {
                self.checker.ty(checked_receiver_id).types().to_vec()
            } else {
                vec![checked_receiver_id]
            };
            let mut bytes = Vec::new();
            let mut bytes_only = true;
            for arm in checked_receiver_arms {
                if self
                    .checker
                    .ty(arm)
                    .flags
                    .intersects(TypeFlags::NULL | TypeFlags::UNDEFINED)
                {
                    continue;
                }
                match self.type_id(arm) {
                    Some(ty @ Type::Bytes { .. }) => bytes.push(ty),
                    _ => bytes_only = false,
                }
            }
            (bytes_only && bytes.len() == 1).then(|| bytes.remove(0))
        } else {
            None
        };
        let method_symbol = self.symbol(member.name());
        if matches!(present.ty(), Type::Object { .. })
            && let Some(value) = self.class_call_on_value(node, present.clone())?
        {
            return Ok(value);
        }
        if present.ty() == Type::Stats
            && matches!(method, "isFile" | "isDirectory" | "isSymbolicLink")
        {
            if !node.arguments().is_empty() {
                return Err(self.refuse(node, "optional Stats methods do not accept arguments"));
            }
            return Ok(Expr::LibCall {
                r#fn: format!("stats.{method}"),
                args: vec![present],
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if self.namespace_capsule(&present.ty()) {
            // A nullable dynamic-import result narrows to its native namespace
            // identity before this call. Read the export through that identity
            // and then use its represented callable ABI; never erase the
            // namespace into a dynamic receiver.
            let callee = self.namespace_property_value(member, present)?;
            let callee = self.callable_body(callee, node)?;
            let Type::Func { params, ret, rest } = callee.ty() else {
                return Err(self.refuse(
                    node,
                    "module namespace member is not a represented callable",
                ));
            };
            let args = self.rest_call_arguments(node, &params, rest)?;
            return Ok(Expr::CallValue {
                callee: Box::new(callee),
                args,
                r#type: *ret,
                loc: self.loc(node),
            });
        }
        let optional_field = if optional_call {
            match present.ty() {
                Type::Record { shape_id } if !self.records[shape_id].tuple => self.records
                    [shape_id]
                    .fields
                    .iter()
                    .find(|field| field.name == method)
                    .map(|field| field.r#type.clone())
                    .filter(|ty| self.optional_callable_type(ty))
                    .map(|field_type| Expr::RecordGet {
                        obj: Box::new(present.clone()),
                        shape_id: format!("r{shape_id}"),
                        field: method.into(),
                        r#type: field_type,
                        loc: self.loc(member),
                    }),
                Type::Object { class_name } => self
                    .ensure_contract_field(&class_name, method, member)?
                    .filter(|ty| self.optional_callable_type(ty))
                    .map(|field_type| Expr::FieldGet {
                        obj: Box::new(present.clone()),
                        class_name,
                        field: method.into(),
                        r#type: field_type,
                        loc: self.loc(member),
                    }),
                _ => None,
            }
        } else {
            None
        };
        if let Some(field) = optional_field {
            // `receiver.method?.(args)` tests the function-valued slot, not
            // the receiver. Keep a typed projection: erasing the complete
            // object can expose unrelated native-only fields and also loses
            // the owning call reference.
            let (callee, nullish) = self.optional_receiver(field, node)?;
            let callee = self.callable_body(callee, node)?;
            let mut value = if callee.ty() == Type::Dyn {
                if node
                    .arguments()
                    .into_iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                {
                    return Err(self.refuse(
                        node,
                        "optional dynamic data field call spreads are not ported",
                    ));
                }
                let args = node
                    .arguments()
                    .into_iter()
                    .map(|argument| self.expected_expression(argument, Type::Dyn))
                    .collect::<Result<Vec<_>, _>>()?;
                Expr::DynCall {
                    callee: Box::new(callee),
                    callee_name: method.into(),
                    args,
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }
            } else {
                let Type::Func { params, ret, rest } = callee.ty() else {
                    return Err(self.refuse(
                        node,
                        "optional data field requires one represented callable arm",
                    ));
                };
                let args = self.rest_call_arguments(node, &params, rest)?;
                Expr::CallValue {
                    callee: Box::new(callee),
                    args,
                    r#type: *ret,
                    loc: self.loc(node),
                }
            };
            if let Some(cond) = nullish {
                if value.ty() == Type::Void {
                    value = Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: value,
                            loc: self.loc(node),
                        }],
                        result: Box::new(Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(node),
                        }),
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    };
                }
                let result_type = self.optional_result_type(value.ty(), node)?;
                let undefined = self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    result_type.clone(),
                    node,
                )?;
                let value = self.coerce(value, result_type.clone(), node)?;
                return Ok(Expr::Ternary {
                    cond: Box::new(cond),
                    then: Box::new(undefined),
                    else_: Box::new(value),
                    r#type: result_type,
                    loc: self.loc(node),
                });
            }
            return Ok(value);
        }
        let bytes_receiver_type = if matches!(present.ty(), Type::Bytes { .. }) {
            Some(present.ty())
        } else {
            checked_receiver
                .clone()
                .filter(|ty| matches!(ty, Type::Bytes { .. }))
                .or(checked_bytes_receiver)
        };
        if method == "toString"
            && let Some(expected) = bytes_receiver_type
        {
            if expected != Type::bytes() {
                return Err(self.refuse(
                    node,
                    "floating typed array toString is not ported; use join",
                ));
            }
            let receiver = if present.ty() == expected && !(nullable && !optional) {
                present
            } else {
                let source = if nullable && !optional {
                    original
                } else {
                    present
                };
                let dynamic = self.coerce(source, Type::Dyn, node)?;
                self.coerce(dynamic, expected, node)?
            };
            return self.bytes_string_call(node, receiver);
        }
        if optional_call
            && present.ty() == Type::Dyn
            && !checked_receiver
                .as_ref()
                .is_some_and(|receiver| self.array_view(receiver))
        {
            let receiver = self.coerce(present, Type::Dyn, node)?;
            let args = node
                .arguments()
                .into_iter()
                .map(|argument| self.expected_expression(argument, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Expr::DynInvoke {
                recv: Box::new(receiver),
                method: method.into(),
                callee_name: method.into(),
                optional: true,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        if !optional_call
            && let Type::Record { shape_id } = present.ty()
            && !self.records[shape_id].tuple
            && self.records[shape_id].index_value.is_none()
            && !self.callables.contains_key(&shape_id)
            && !self.enum_shape(shape_id)
            && let Some(field_type) = self.records[shape_id]
                .fields
                .iter()
                .find(|field| field.name == method)
                .map(|field| field.r#type.clone())
            && matches!(field_type, Type::Func { .. })
        {
            // `receiver?.method(args)` skips only the nullish receiver. Once
            // present, an ordinary data-record function slot is invoked with
            // the record as its JavaScript `this`, exactly like a non-optional
            // member call. RecordGet retains that receiver through emission.
            let callee = Expr::RecordGet {
                obj: Box::new(present),
                shape_id: format!("r{shape_id}"),
                field: method.into(),
                r#type: field_type,
                loc: self.loc(member),
            };
            let callee = self.callable_body(callee, node)?;
            let Type::Func { params, ret, rest } = callee.ty() else {
                unreachable!("record callable body")
            };
            let args = self.rest_call_arguments(node, &params, rest)?;
            return Ok(Expr::CallValue {
                callee: Box::new(callee),
                args,
                r#type: *ret,
                loc: self.loc(node),
            });
        }
        if matches!(method, "toString" | "toISOString" | "getTime" | "valueOf")
            && present.ty() == Type::Dyn
            && (self.primitive_symbol(method_symbol, method, Some("Date"))
                || method != "toString"
                    && method_symbol == 0
                    && matches!(checked_receiver.as_ref(), None | Some(Type::Dyn)))
        {
            let receiver = if nullable && !optional {
                original
            } else {
                present
            };
            let receiver = self.coerce(receiver, Type::Dyn, node)?;
            let args = node
                .arguments()
                .into_iter()
                .map(|argument| self.expected_expression(argument, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            let value = Expr::DynInvoke {
                recv: Box::new(receiver),
                method: method.into(),
                callee_name: method.into(),
                optional: false,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            let result = if matches!(method, "toString" | "toISOString") {
                Type::String
            } else {
                Type::F64
            };
            return self.coerce(value, result, node);
        }
        let array_sequence_name = matches!(
            method,
            "some" | "every" | "filter" | "slice" | "find" | "findIndex" | "reduce" | "reduceRight"
        );
        let standard_array_sequence = array_sequence_name
            && (self.primitive_symbol(method_symbol, method, Some("Array"))
                || self.primitive_symbol(method_symbol, method, Some("ReadonlyArray")));
        // Plain JavaScript dependencies often expose an unresolved member
        // symbol on an `any` receiver. The runtime Array check below is then
        // the native contract; a resolved custom member is never reclassified.
        let dynamic_array_sequence = array_sequence_name
            && present.ty() == Type::Dyn
            && method_symbol == 0
            && matches!(checked_receiver.as_ref(), None | Some(Type::Dyn));
        let concrete_array = |lowerer: &Self, ty: &Type| match ty {
            Type::Array { .. } => Some(ty.clone()),
            _ => lowerer.nullable_array_element(ty).map(|elem| Type::Array {
                elem: Box::new(elem),
            }),
        };
        let array_type = if let Some(array) = concrete_array(self, &present.ty()) {
            Some(array)
        } else {
            checked_receiver
                .clone()
                .and_then(|ty| concrete_array(self, &ty))
                .or_else(|| {
                    (present.ty() == Type::Dyn
                        && (standard_array_sequence || dynamic_array_sequence))
                        .then(|| Type::Array {
                            elem: Box::new(Type::Dyn),
                        })
                })
        };
        if let Some(expected) = array_type {
            let receiver = if present.ty() != expected || nullable && !optional {
                // A `?.` earlier in the same chain skips this operation. When
                // execution does reach a plain `.method()` on a receiver that
                // is independently nullable, JavaScript throws instead of
                // silently skipping it. Re-check the owning union/dynamic
                // value before entering the native array implementation.
                let source = if nullable && !optional {
                    original.clone()
                } else {
                    present.clone()
                };
                let value = self.coerce(source, Type::Dyn, node)?;
                self.coerce(value, expected, node)?
            } else {
                present.clone()
            };
            if method == "includes" {
                return self.array_includes_value(node, receiver, true);
            }
            if method == "join" {
                return self.array_join_value(node, receiver);
            }
            if method == "toString" && !optional_call {
                if !node.arguments().is_empty() {
                    return Err(
                        self.refuse(node, "optional array toString with arguments is not ported")
                    );
                }
                let receiver = self.coerce(receiver, Type::Dyn, node)?;
                return Ok(Expr::LibCall {
                    r#fn: "array.toString".into(),
                    args: vec![receiver],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
            if method == "map" {
                return self.array_map_value(node, receiver, None);
            }
            if method == "flatMap" {
                return self.array_flat_map_value(node, receiver);
            }
            if matches!(method, "push" | "unshift") && !optional_call {
                return self.optional_array_mutation_value(node, receiver, method);
            }
            if array_sequence_name {
                return self.array_sequence_method_value(node, receiver, !dynamic_array_sequence);
            }
        }
        if matches!(present.ty(), Type::Set { .. }) {
            // The optional chain has already tested and narrowed the owning
            // nullable slot.  Keep using the typed Set ABI for the method
            // call instead of boxing the container as a dynamic receiver.
            // This covers both `set?.has(value)` and continuations whose
            // receiver was made present by an earlier optional step.
            return self.set_intrinsic(
                node,
                present,
                method,
                node.arguments().into_iter().collect(),
            );
        }
        if matches!(present.ty(), Type::Map { .. }) {
            // Map has the same receiver-presence semantics as Set.  Routing
            // it here also keeps optional collection calls consistent with
            // their ordinary-call lowering and preserves the concrete key
            // and value contracts.
            return self.map_intrinsic(
                node,
                present,
                method,
                node.arguments().into_iter().collect(),
            );
        }
        if present.ty() == Type::Regex && matches!(method, "test" | "exec") {
            if node.arguments().len() != 1 {
                return Err(self.refuse(
                    node,
                    "optional RegExp.test/exec require one represented string argument",
                ));
            }
            let argument = node.arguments().into_iter().next().unwrap();
            let argument = self.expected_expression(argument, Type::String)?;
            let result = if method == "exec" {
                let captures = self.regex_capture_array();
                self.intern_union(vec![captures, Type::Null])
                    .expect("regex result")
            } else {
                Type::Bool
            };
            return Ok(Expr::RegexIntrinsic {
                method: method.into(),
                receiver: Box::new(present),
                args: vec![argument],
                r#type: result,
                loc: self.loc(node),
            });
        }
        if present.ty() == Type::Child && method == "kill" {
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if args.len() > 1
                || args
                    .iter()
                    .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(node, "optional child.kill accepts zero or one signal"));
            }
            let signal = if let Some(arg) = args.first() {
                self.expected_expression(*arg, Type::String)?
            } else {
                Expr::StrLit {
                    value: "SIGTERM".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            };
            self.ensure_exception_classes(node)?;
            return Ok(Expr::LibCall {
                r#fn: "child.kill".into(),
                args: vec![present, signal],
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        let standard_string = self.primitive_symbol(method_symbol, method, Some("String"))
            || checked_receiver
                .as_ref()
                .is_some_and(|ty| self.string_view(ty))
                && (crate::string_builtins::by_method(method).is_some() || method == "match");
        if matches!(present.ty(), Type::String | Type::Dyn) && standard_string {
            if method == "match" {
                let receiver = if present.ty() == Type::Dyn {
                    self.coerce(present, Type::String, node)?
                } else {
                    present
                };
                return self.string_match_value(node, receiver);
            }
            return self.optional_string_call(node, present, true);
        }
        let timer_receiver = self.checker.get_type_at_location(member.expression());
        if matches!(present.ty(), Type::F64 | Type::Dyn)
            && matches!(method, "unref" | "ref" | "hasRef" | "refresh")
            && (self.timer_handle_type(timer_receiver)
                || self.timer_callable_value(member)
                || self.timer_method_symbol(method_symbol))
        {
            if !node.arguments().is_empty() {
                return Err(
                    self.refuse(node, "native timer handle methods do not accept arguments")
                );
            }
            // Node exposes timer handles as objects while the portable runtime
            // stores their stable numeric id. Optional method syntax such as
            // `timer.unref?.()` still targets that native handle method; it is
            // not a dynamic property call on the represented f64.
            let handle = if nullable && !optional {
                self.coerce(original, Type::F64, node)?
            } else {
                self.coerce(present, Type::F64, node)?
            };
            let (r#fn, args, r#type) = match method {
                "unref" => (
                    "timers.setRef",
                    vec![
                        handle,
                        Expr::BoolLit {
                            value: false,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        },
                    ],
                    Type::F64,
                ),
                "ref" => (
                    "timers.setRef",
                    vec![
                        handle,
                        Expr::BoolLit {
                            value: true,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        },
                    ],
                    Type::F64,
                ),
                "hasRef" => ("timers.hasRef", vec![handle], Type::Bool),
                "refresh" => ("timers.refresh", vec![handle], Type::F64),
                _ => unreachable!(),
            };
            return Ok(Expr::LibCall {
                r#fn: r#fn.into(),
                args,
                r#type,
                loc: self.loc(node),
            });
        }
        let standard_number = matches!(
            method,
            "toString" | "toFixed" | "toExponential" | "toPrecision" | "toLocaleString"
        ) && (present.ty() == Type::F64
            || self.primitive_symbol(method_symbol, method, Some("Number"))
            || checked_receiver.as_ref() == Some(&Type::F64));
        if present.ty() == Type::F64 && standard_number {
            return self.number_string_call_value(node, present);
        }
        if present.ty() == Type::Dyn {
            let receiver = if nullable && !optional {
                original
            } else {
                present
            };
            let receiver = self.coerce(receiver, Type::Dyn, node)?;
            let args = node
                .arguments()
                .into_iter()
                .map(|argument| self.expected_expression(argument, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Expr::DynInvoke {
                recv: Box::new(receiver),
                method: method.into(),
                callee_name: method.into(),
                optional: false,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        if nullable && !optional {
            return Err(self.refuse(
                node,
                &format!(
                    "nullable non-optional method calls need a native receiver-call contract for {:?}",
                    present.ty()
                ),
            ));
        }
        self.optional_string_call(node, present, false)
    }

    fn optional_array_mutation_value(
        &mut self,
        node: Node,
        receiver: Expr,
        method: &str,
    ) -> Result<Expr, String> {
        let receiver = self.coerce(receiver, Type::Dyn, node)?;
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            // A computed argument list must be evaluated after the live method
            // lookup, while keeping the original array as the call receiver.
            let mut statements = Vec::new();
            let receiver =
                self.update_temp(receiver, &mut statements, node.expression().expression());
            let key = Expr::StrLit {
                value: method.into(),
                r#type: Type::String,
                loc: self.loc(node),
            };
            let callee = self.dynamic_get(node, receiver.clone(), key);
            let callee = self.update_temp(callee, &mut statements, node.expression());
            let values = self.array_spread_elements(
                node,
                arguments,
                Type::Array {
                    elem: Box::new(Type::Dyn),
                },
            )?;
            return Ok(Expr::Sequence {
                stmts: statements,
                result: Box::new(Expr::LibCall {
                    r#fn: "dyn.callWithThisSpread".into(),
                    args: vec![callee, receiver, values],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let args = arguments
            .into_iter()
            .map(|argument| self.expected_expression(argument, Type::Dyn))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Expr::DynInvoke {
            recv: Box::new(receiver),
            method: method.into(),
            callee_name: method.into(),
            optional: false,
            args,
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }

    fn optional_string_call(
        &mut self,
        node: Node,
        receiver: Expr,
        proven_string: bool,
    ) -> Result<Expr, String> {
        let member = node.expression();
        let id = self.symbol(member.name());
        let name = member.name().text();
        if !matches!(receiver.ty(), Type::String | Type::Dyn)
            || !(proven_string
                || self.primitive_symbol(id, name, Some("String"))
                || id == 0
                    && receiver.ty() == Type::String
                    && crate::string_builtins::by_method(name).is_some())
        {
            return Err(self.refuse(
                node,
                &format!(
                    "optional call {name} requires a native receiver-call contract for {:?}",
                    receiver.ty()
                ),
            ));
        }
        let receiver = if receiver.ty() == Type::Dyn {
            self.coerce(receiver, Type::String, node)?
        } else {
            receiver
        };
        if name == "split" {
            return self.string_split_value(node, receiver);
        }
        let Some(operation) = crate::string_builtins::by_method(name).filter(|_| name != "length")
        else {
            return Err(self.refuse(
                node,
                "optional calls require a native receiver-call contract",
            ));
        };
        let mut values = vec![receiver];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "optional string call spreads are not ported"));
            }
            let value = self.primitive_operand(argument)?;
            values.push(self.primitive_capture(value, argument)?);
        }
        self.ensure_exception_classes(node)?;
        let mut helper = helpers::Helper::new(
            &format!("optional_string_{name}"),
            values.iter().map(Expr::ty).collect(),
            operation.result.clone(),
            self.loc(node),
        );
        if matches!(name, "replace" | "replaceAll")
            && values.get(1).is_some_and(|value| value.ty() == Type::Regex)
        {
            let replacement = (values.len() > 2).then(|| helper.read(&helper.param(2)));
            let replacement = self.primitive_string_argument(
                replacement,
                crate::string_builtins::Argument::Text("undefined"),
                node,
            )?;
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::RegexIntrinsic {
                    method: name.into(),
                    receiver: Box::new(helper.read(&helper.param(0))),
                    args: vec![helper.read(&helper.param(1)), replacement],
                    r#type: Type::String,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Expr::Call {
                callee: self.install_helper(helper.function),
                args: values,
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        let mut args = Vec::new();
        for (index, expected) in operation.args.iter().enumerate() {
            let value = (index + 1 < values.len()).then(|| helper.read(&helper.param(index + 1)));
            let value = self.primitive_string_argument(value, *expected, node)?;
            let local = helper.local(&format!("argument{index}"), value.ty(), false);
            helper.declare(&local, value);
            args.push(helper.read(&local));
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::StringIntrinsic {
                method: name.into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args,
                r#type: operation.result.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: operation.result.clone(),
            loc: self.loc(node),
        })
    }

    fn optional_receiver(&self, value: Expr, node: Node) -> Result<(Expr, Option<Expr>), String> {
        if value.ty() == Type::Dyn {
            let test = Expr::DynTest {
                value: Box::new(value.clone()),
                test: "nullish".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            };
            return Ok((value, Some(test)));
        }
        let Type::Union { union_id } = value.ty() else {
            return Ok((value, None));
        };
        let arms = &self.unions[union_id].arms;
        let present = arms
            .iter()
            .enumerate()
            .filter(|(_, ty)| !matches!(ty, Type::Null | Type::Undefined))
            .collect::<Vec<_>>();
        let [(tag, ty)] = present.as_slice() else {
            // A discriminated union can have several present record arms plus
            // nullish. NativeValue preserves those owning record identities;
            // use it as the union envelope for the nullish test and property
            // lookup. Erasure fences still reject namespaces, Sets and other
            // layouts whose contracts cannot cross this boundary.
            let value = self.coerce(value, Type::Dyn, node)?;
            let test = Expr::DynTest {
                value: Box::new(value.clone()),
                test: "nullish".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            };
            return Ok((value, Some(test)));
        };
        let mut test = None;
        for (tag, arm) in arms.iter().enumerate() {
            if matches!(arm, Type::Null | Type::Undefined) {
                let is_tag = Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(value.clone()),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                };
                test = Some(if let Some(previous) = test {
                    Expr::Logical {
                        op: "||".into(),
                        left: Box::new(previous),
                        right: Box::new(is_tag),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }
                } else {
                    is_tag
                });
            }
        }
        let present = Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag: *tag,
            value: Box::new(value),
            r#type: (*ty).clone(),
            loc: self.loc(node),
        };
        Ok((present, test))
    }

    fn optional_callable_type(&self, ty: &Type) -> bool {
        let callable = |arm: &Type| match arm {
            Type::Func { .. } | Type::Dyn => true,
            Type::Record { shape_id } => self.callables.contains_key(shape_id),
            _ => false,
        };
        match ty {
            ty if callable(ty) => true,
            Type::Union { union_id } => {
                let arms = &self.unions[*union_id].arms;
                let present = arms
                    .iter()
                    .filter(|arm| !matches!(arm, Type::Null | Type::Undefined))
                    .collect::<Vec<_>>();
                matches!(present.as_slice(), [arm] if callable(arm))
                    && arms
                        .iter()
                        .any(|arm| matches!(arm, Type::Null | Type::Undefined))
            }
            _ => false,
        }
    }

    fn optional_key(&mut self, node: Node) -> Result<Expr, String> {
        if node.kind() == SyntaxKind::PropertyAccessExpression {
            return Ok(Expr::StrLit {
                value: node.name().text().into(),
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        self.dynamic_read_key_expression(node.argument_expression())
    }

    fn optional_member_type(&mut self, node: Node, receiver: &Type) -> Result<Type, String> {
        if *receiver == Type::Stats {
            let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
                Some(node.name().text().to_owned())
            } else {
                self.literal_property_key(node.argument_expression())
            };
            return match name.as_deref() {
                Some(
                    "size" | "mode" | "uid" | "gid" | "atimeMs" | "mtimeMs" | "dev" | "ino"
                    | "blocks" | "nlink",
                ) => Ok(Type::F64),
                _ => Err(self.refuse(node, "optional Stats property is not ported")),
            };
        }
        if matches!(receiver, Type::Bytes { .. })
            && node.kind() == SyntaxKind::ElementAccessExpression
        {
            return self.undefined_storage_type(Type::F64, node);
        }
        if matches!(receiver, Type::Bytes { .. })
            && node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "length"
        {
            return Ok(Type::F64);
        }
        if let Type::Array { elem } = receiver {
            let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
                Some(node.name().text().to_owned())
            } else {
                self.literal_property_key(node.argument_expression())
            };
            if name.as_deref() == Some("length") {
                return Ok(Type::F64);
            }
            if node.kind() == SyntaxKind::ElementAccessExpression {
                let key = self
                    .checker
                    .get_type_at_location(node.argument_expression());
                if self
                    .checker
                    .ty(key)
                    .flags
                    .intersects(TypeFlags::NUMBER_LIKE)
                    || name.is_some_and(|name| name.parse::<f64>().is_ok())
                {
                    return self.undefined_storage_type(elem.as_ref().clone(), node);
                }
            }
            return Err(self.refuse(
                node,
                "optional array access requires a numeric index or length",
            ));
        }
        if *receiver == Type::String {
            return self.string_index_type(node);
        }
        if *receiver == Type::Dyn {
            return Ok(Type::Dyn);
        }
        if let Type::Object { class_name } = receiver {
            let field = if node.kind() == SyntaxKind::PropertyAccessExpression {
                Some(node.name().text().to_owned())
            } else {
                self.literal_property_key(node.argument_expression())
            }
            .ok_or_else(|| {
                self.refuse(
                    node,
                    "optional class access requires a literal public data key",
                )
            })?;
            if field == "destroyed"
                && matches!(
                    class_name.as_str(),
                    "native_builtin_Transform"
                        | "native_builtin_Duplex"
                        | "native_builtin_Readable"
                        | "native_builtin_Writable"
                )
            {
                return Ok(Type::Bool);
            }
            if let Some(ty) = self.ensure_contract_field(class_name, &field, node)? {
                return Ok(ty);
            }
            if self.classes.subclass(class_name, "%Error") {
                // Error subclasses retain arbitrary own properties in the
                // shared dynamic bag. Optional reads must observe that same
                // identity-bearing store rather than inventing a fixed slot.
                return Ok(Type::Dyn);
            }
            return Err(self.refuse(
                node,
                &format!("optional class data property {class_name}.{field} is not ported"),
            ));
        }
        let Type::Record { shape_id } = *receiver else {
            return Err(self.refuse(
                node,
                "optional access receiver needs a native dictionary or data record",
            ));
        };
        let record = self.records[shape_id].clone();
        if record.tuple || self.callables.contains_key(&shape_id) || self.enum_shape(shape_id) {
            return Err(self.refuse(
                node,
                "optional tuple, callable and enum views require their native member contracts",
            ));
        }
        if let Some(value) = record.index_value {
            return self.undefined_storage_type(value, node);
        }
        let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
            Some(node.name().text().into())
        } else {
            self.literal_property_key(node.argument_expression())
        };
        let field = name.and_then(|name| record.fields.iter().find(|field| field.name == name));
        Ok(field.map_or(Type::Dyn, |field| field.r#type.clone()))
    }

    fn optional_member(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        let method_symbol = if node.kind() == SyntaxKind::PropertyAccessExpression {
            self.symbol(node.name())
        } else {
            0
        };
        if matches!(receiver.ty(), Type::F64 | Type::Dyn)
            && node.kind() == SyntaxKind::PropertyAccessExpression
            && matches!(
                node.name().text().as_ref(),
                "refresh" | "unref" | "ref" | "hasRef"
            )
            && (self.timer_callable_value(node) || self.timer_method_symbol(method_symbol))
        {
            let receiver = self.coerce(receiver, Type::F64, node)?;
            return Ok(Expr::LibCall {
                r#fn: "timers.methodValue".into(),
                args: vec![
                    receiver,
                    Expr::StrLit {
                        value: node.name().text().to_string(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                ],
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        if receiver.ty() == Type::Stats {
            let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
                Some(node.name().text().to_owned())
            } else {
                self.literal_property_key(node.argument_expression())
            };
            let operation = match name.as_deref() {
                Some("size") => "stats.size",
                Some("mode") => "stats.mode",
                Some("uid") => "stats.uid",
                Some("gid") => "stats.gid",
                Some("atimeMs") => "stats.atimeMs",
                Some("mtimeMs") => "stats.mtimeMs",
                Some("dev") => "stats.dev",
                Some("ino") => "stats.ino",
                Some("blocks") => "stats.blocks",
                Some("nlink") => "stats.nlink",
                _ => return Err(self.refuse(node, "optional Stats property is not ported")),
            };
            return Ok(Expr::LibCall {
                r#fn: operation.into(),
                args: vec![receiver],
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        if matches!(receiver.ty(), Type::Bytes { .. })
            && node.kind() == SyntaxKind::ElementAccessExpression
        {
            return self.bytes_index(node, receiver);
        }
        if matches!(receiver.ty(), Type::Bytes { .. })
            && node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "length"
        {
            return Ok(self.bytes_operation(node, receiver, "length", vec![], Type::F64));
        }
        if receiver.ty() == Type::String {
            return self.string_index(node, receiver);
        }
        let result_type = self.optional_member_type(node, &receiver.ty())?;
        let key = self.optional_key(node)?;
        if matches!(receiver.ty(), Type::Array { .. }) {
            let receiver = self.coerce(receiver, Type::Dyn, node)?;
            let value = self.dynamic_get(node, receiver, key);
            return self.coerce(value, result_type, node);
        }
        if receiver.ty() == Type::Dyn {
            return Ok(self.dynamic_get(node, receiver, key));
        }
        if let Type::Object { class_name } = receiver.ty() {
            let field = if node.kind() == SyntaxKind::PropertyAccessExpression {
                Some(node.name().text().to_owned())
            } else {
                self.literal_property_key(node.argument_expression())
            }
            .expect("optional class field type validated the literal key");
            if field == "destroyed"
                && matches!(
                    class_name.as_str(),
                    "native_builtin_Transform"
                        | "native_builtin_Duplex"
                        | "native_builtin_Readable"
                        | "native_builtin_Writable"
                )
            {
                return Ok(Expr::LibCall {
                    r#fn: "nodeStream.destroyed".into(),
                    args: vec![receiver],
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            if self.field_type(&class_name, &field).is_none()
                && self.classes.subclass(&class_name, "%Error")
            {
                return Ok(self.dynamic_get(node, self.coerce(receiver, Type::Dyn, node)?, key));
            }
            return Ok(Expr::FieldGet {
                obj: Box::new(receiver),
                class_name,
                field,
                r#type: result_type,
                loc: self.loc(node),
            });
        }
        let Type::Record { shape_id } = receiver.ty() else {
            unreachable!()
        };
        if self.records[shape_id].index_value.is_some() || result_type == Type::Dyn {
            return self.dictionary_get(node, receiver, key);
        }
        let Expr::StrLit { value: name, .. } = key else {
            return Err(self.refuse(
                node,
                "optional record access requires a known literal data field",
            ));
        };
        Ok(Expr::RecordGet {
            obj: Box::new(receiver),
            shape_id: format!("r{shape_id}"),
            field: name,
            r#type: result_type,
            loc: self.loc(node),
        })
    }
}
