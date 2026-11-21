//! Standard owning sequences lower to portable loops with fresh lexical cells.
use super::*;
use helpers::Helper;

fn read(local: &Local, loc: &Loc) -> Expr {
    Expr::VarRef {
        local_id: local.id.clone(),
        r#type: local.r#type.clone(),
        loc: loc.clone(),
    }
}
fn number(value: f64, loc: &Loc) -> Expr {
    Expr::NumLit {
        value,
        spelling: None,
        r#type: Type::F64,
        loc: loc.clone(),
    }
}
fn binary(op: &str, left: Expr, right: Expr, loc: &Loc) -> Expr {
    Expr::Bin {
        op: op.into(),
        left: Box::new(left),
        right: Box::new(right),
        r#type: if op == "+" { Type::F64 } else { Type::Bool },
        loc: loc.clone(),
    }
}

fn iteration_requires_close(body: &[Stmt], nested_break_targets: usize) -> bool {
    body.iter().any(|stmt| match stmt {
        // Throws, including failures from arbitrary expressions in the loop
        // body, are closed by the synthetic protected region below. Returns
        // Returns need their pending completion preserved explicitly. Breaks
        // are rewritten with their close sequence before this check runs.
        Stmt::Return { .. } => true,
        Stmt::While { body, .. } | Stmt::GeneratorForOf { body, .. } => {
            iteration_requires_close(body, nested_break_targets + 1)
        }
        Stmt::Switch { cases, .. } => cases
            .iter()
            .any(|case| iteration_requires_close(&case.body, nested_break_targets + 1)),
        Stmt::Block { body, .. } => iteration_requires_close(body, nested_break_targets),
        Stmt::If { then, else_, .. } => {
            iteration_requires_close(then, nested_break_targets)
                || else_
                    .as_ref()
                    .is_some_and(|body| iteration_requires_close(body, nested_break_targets))
        }
        Stmt::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            iteration_requires_close(try_body, nested_break_targets)
                || catch_body
                    .as_ref()
                    .is_some_and(|body| iteration_requires_close(body, nested_break_targets))
                || finally_body
                    .as_ref()
                    .is_some_and(|body| iteration_requires_close(body, nested_break_targets))
        }
        _ => false,
    })
}

fn close_iteration_breaks(body: &mut Vec<Stmt>, nested_break_targets: usize, close: &[Stmt]) {
    let mut output = Vec::with_capacity(body.len());
    for mut stmt in std::mem::take(body) {
        match &mut stmt {
            Stmt::Break { target_depth, .. } if *target_depth == nested_break_targets => {
                output.extend_from_slice(close);
            }
            Stmt::While { body, .. } | Stmt::GeneratorForOf { body, .. } => {
                close_iteration_breaks(body, nested_break_targets + 1, close);
            }
            Stmt::Switch { cases, .. } => {
                for case in cases {
                    close_iteration_breaks(&mut case.body, nested_break_targets + 1, close);
                }
            }
            Stmt::Block { body, .. } => {
                close_iteration_breaks(body, nested_break_targets, close);
            }
            Stmt::If { then, else_, .. } => {
                close_iteration_breaks(then, nested_break_targets, close);
                if let Some(other) = else_ {
                    close_iteration_breaks(other, nested_break_targets, close);
                }
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                close_iteration_breaks(try_body, nested_break_targets, close);
                if let Some(catch) = catch_body {
                    close_iteration_breaks(catch, nested_break_targets, close);
                }
                if let Some(finally) = finally_body {
                    close_iteration_breaks(finally, nested_break_targets, close);
                }
            }
            _ => {}
        }
        output.push(stmt);
    }
    *body = output;
}

impl Lowerer<'_> {
    fn validate_object_iteration_pattern(&mut self, pattern: Node) -> Result<(), String> {
        for element in pattern.elements() {
            let property_name = element.property_name();
            let computed_symbol = !property_name.is_nil()
                && property_name.kind() == SyntaxKind::ComputedPropertyName
                && self.class_symbol_key(property_name.expression()).is_some();
            let name = element.name();
            if !matches!(
                name.kind(),
                SyntaxKind::Identifier | SyntaxKind::ObjectBindingPattern
            ) || !element.dot_dot_dot_token().is_nil()
                || !element.initializer().is_nil()
                || (!property_name.is_nil()
                    && self.data_property_name(property_name).is_none()
                    && !computed_symbol)
            {
                return Err(self.refuse(
                    element,
                    "for-of object bindings require named or stable symbol fields without rest or defaults",
                ));
            }
            if name.kind() == SyntaxKind::ObjectBindingPattern {
                self.validate_object_iteration_pattern(name)?;
            }
        }
        Ok(())
    }

    /// Statement-position `yield*` in an async generator drives the async
    /// iterator protocol one promise at a time. Keeping this as ordinary
    /// Await/Yield IR lets the existing async-generator continuation planner
    /// retain the iterator and loop state across both suspension kinds.
    pub(super) fn async_yield_star_statement(
        &mut self,
        statement: Node,
    ) -> Result<Option<Vec<Stmt>>, String> {
        if statement.kind() != SyntaxKind::ExpressionStatement {
            return Ok(None);
        }
        let yield_node = statement.expression();
        if yield_node.kind() != SyntaxKind::YieldExpression
            || yield_node.asterisk_token().is_nil()
            || !self.is_async_function
        {
            return Ok(None);
        }
        let Some(channels) = self.generator.clone() else {
            return Ok(None);
        };
        let source_node = yield_node.expression();
        // A public interface can structurally map AsyncGenerator to a record
        // even though its live value implements Symbol.asyncIterator (the
        // Recker response facade is one such boundary). Known synchronous
        // iterables retain the ordinary YieldStar path; every other async-body
        // delegate is checked by the async-iterator protocol at runtime.
        if matches!(
            self.ty(source_node),
            Ok(Type::Generator { r#async: false, .. }
                | Type::Array { .. }
                | Type::Set { .. }
                | Type::String)
        ) {
            return Ok(None);
        }

        let loc = self.loc(statement);
        let source_value = self.expression(source_node)?;
        let source = self.coerce(source_value, Type::Dyn, source_node)?;
        let iterator = self.iteration_local("yield* async iterator", Type::Dyn, false);
        let active = self.iteration_local("yield* async iterator active", Type::Bool, true);
        let step = self.iteration_local("yield* async iterator step", Type::Dyn, false);

        let next = Expr::DynInvoke {
            recv: Box::new(read(&iterator, &loc)),
            method: "next".into(),
            callee_name: "AsyncIterator.next".into(),
            optional: false,
            args: vec![],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let awaited = Expr::Await {
            value: Box::new(self.coerce(
                next,
                Type::Promise {
                    inner: Box::new(Type::Dyn),
                },
                yield_node,
            )?),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let done_value = self.dynamic_get(
            yield_node,
            read(&step, &loc),
            Expr::StrLit {
                value: "done".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let done = self.coerce(done_value, Type::Bool, yield_node)?;
        let item_value = self.dynamic_get(
            yield_node,
            read(&step, &loc),
            Expr::StrLit {
                value: "value".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let item = self.coerce(item_value, channels.yield_type.clone(), yield_node)?;
        let resume_type = if channels.next_type == Type::Undefined {
            Type::Void
        } else {
            channels.next_type
        };
        let loop_body = vec![
            Stmt::VarDecl {
                local_id: step.id,
                init: awaited,
                loc: loc.clone(),
            },
            Stmt::If {
                cond: done,
                then: vec![Stmt::Assign {
                    local_id: active.id.clone(),
                    value: Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    initializes_global: false,
                    loc: loc.clone(),
                }],
                else_: Some(vec![Stmt::Expression {
                    expr: Expr::Yield {
                        value: Box::new(item),
                        r#type: resume_type,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }]),
                loc: loc.clone(),
            },
        ];
        Ok(Some(vec![Stmt::Block {
            body: vec![
                Stmt::VarDecl {
                    local_id: iterator.id,
                    init: Expr::LibCall {
                        r#fn: "dyn.asyncIterator".into(),
                        args: vec![source],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::VarDecl {
                    local_id: active.id.clone(),
                    init: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::While {
                    cond: read(&active, &loc),
                    body: loop_body,
                    loc: loc.clone(),
                },
            ],
            loc,
        }]))
    }

    fn iteration_local(&mut self, name: &str, ty: Type, mutable: bool) -> Local {
        let local = Local {
            id: format!("v{}", self.locals.len()),
            name: name.into(),
            r#type: ty,
            mutable,
            boxed: false,
        };
        self.locals.push(local.clone());
        local
    }

    fn bind_object_iteration(
        &mut self,
        pattern: Node,
        item: Expr,
        mutable: bool,
    ) -> Result<Vec<Stmt>, String> {
        self.validate_object_iteration_pattern(pattern)?;
        let source = self.iteration_local("iteration item", item.ty(), false);
        let mut body = vec![Stmt::VarDecl {
            local_id: source.id.clone(),
            init: item,
            loc: self.loc(pattern),
        }];
        for element in pattern.elements() {
            let name = element.name();
            let property_name = element.property_name();
            let symbol_key = if !property_name.is_nil()
                && property_name.kind() == SyntaxKind::ComputedPropertyName
                && self.class_symbol_key(property_name.expression()).is_some()
            {
                Some(property_name.expression())
            } else {
                None
            };
            let key = if property_name.is_nil() {
                name.text().to_string()
            } else if symbol_key.is_some() {
                String::new()
            } else {
                self.data_property_name(property_name).unwrap()
            };
            let source_value = read(&source, &self.loc(element));
            let value = if let Some(symbol_key) = symbol_key {
                let raw = self.coerce(source_value, Type::Dyn, element)?;
                let key = self.expression(symbol_key)?;
                self.dynamic_get(element, raw, key)
            } else if let Type::Record { shape_id } = &source.r#type {
                if let Some(field) = self.records[*shape_id]
                    .fields
                    .iter()
                    .find(|field| field.name == key)
                {
                    Expr::RecordGet {
                        obj: Box::new(source_value),
                        shape_id: format!("r{shape_id}"),
                        field: key,
                        r#type: field.r#type.clone(),
                        loc: self.loc(element),
                    }
                } else {
                    let raw = self.coerce(source_value, Type::Dyn, element)?;
                    self.dynamic_get(
                        element,
                        raw,
                        Expr::StrLit {
                            value: key,
                            r#type: Type::String,
                            loc: self.loc(element),
                        },
                    )
                }
            } else {
                let raw = self.coerce(source_value, Type::Dyn, element)?;
                self.dynamic_get(
                    element,
                    raw,
                    Expr::StrLit {
                        value: key,
                        r#type: Type::String,
                        loc: self.loc(element),
                    },
                )
            };
            if name.kind() == SyntaxKind::ObjectBindingPattern {
                body.extend(self.bind_object_iteration(name, value, mutable)?);
            } else {
                let binding = self.iteration_local(name.text(), value.ty(), mutable);
                let symbol = self.symbol(name);
                self.bindings.insert(symbol, binding.clone());
                if binding.r#type == Type::Dyn || self.optional_storage(&binding.r#type) {
                    self.var_types.insert(symbol, binding.r#type.clone());
                }
                body.push(Stmt::VarDecl {
                    local_id: binding.id,
                    init: value,
                    loc: self.loc(element),
                });
            }
        }
        Ok(body)
    }

    /// Snapshot the receiver's enumerable own string keys, then lower the
    /// source loop to the ordinary native while-loop IR. Ordinary objects and
    /// null-prototype dictionaries have no represented enumerable prototype,
    /// so own-key enumeration is the complete supported `for-in` contract.
    pub(super) fn for_in_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let head = node.initializer();
        let loc = self.loc(node);
        let mut lexical = None;
        let binding_node = if head.kind() == SyntaxKind::Identifier {
            head
        } else if head.kind() == SyntaxKind::VariableDeclarationList {
            let declarations = head.declarations().nodes().into_iter().collect::<Vec<_>>();
            if declarations.len() != 1
                || declarations[0].name().kind() != SyntaxKind::Identifier
                || !declarations[0].initializer().is_nil()
                || !declarations[0].type_().is_nil()
            {
                return Err(self.refuse(
                    head,
                    "for-in requires one identifier binding without an initializer or annotation",
                ));
            }
            if head.flags().intersects(NodeFlags::LET | NodeFlags::CONST) {
                lexical = Some(!head.flags().intersects(NodeFlags::CONST));
            }
            declarations[0].name()
        } else {
            return Err(self.refuse(
                head,
                "for-in assignment targets other than an identifier are not ported",
            ));
        };

        let value = self.expression(node.expression())?;
        if matches!(value.ty(), Type::Null | Type::Undefined | Type::Void) {
            return Err(self.refuse(
                node.expression(),
                "for-in requires an object-coercible value",
            ));
        }
        let value = self.coerce(value, Type::Dyn, node.expression())?;
        let source = self.iteration_local("for-in source", Type::Dyn, false);
        let keys = self.iteration_local("for-in keys", Type::Dyn, false);
        let index = self.iteration_local("for-in index", Type::F64, true);
        let key_value = self.dynamic_get(
            node,
            read(&keys, &loc),
            Expr::ToString {
                operand: Box::new(read(&index, &loc)),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let key_value = self.coerce(key_value, Type::String, node)?;
        let length = self.dynamic_get(
            node,
            read(&keys, &loc),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let length = self.coerce(length, Type::F64, node)?;

        let saved_bindings = self.bindings.clone();
        let saved_var_types = self.var_types.clone();
        let stable_facts = self.immutable_var_facts();
        self.var_defined = stable_facts.clone();

        let mut body = if let Some(mutable) = lexical {
            let binding = self.iteration_local(binding_node.text(), Type::String, mutable);
            let symbol = self.symbol(binding_node);
            self.bindings.insert(symbol, binding.clone());
            vec![Stmt::VarDecl {
                local_id: binding.id,
                init: key_value,
                loc: loc.clone(),
            }]
        } else {
            let symbol = self.symbol(binding_node);
            let binding = self.binding(binding_node)?;
            if !binding.mutable || binding.r#type == Type::Caught {
                return Err(
                    self.refuse(binding_node, "for-in requires a mutable assignment binding")
                );
            }
            let stored = self.coerce(key_value, binding.r#type.clone(), binding_node)?;
            if self.var_types.contains_key(&symbol) {
                self.var_assignment_fact(symbol, &stored);
            }
            vec![Stmt::Assign {
                local_id: binding.id,
                value: stored,
                initializes_global: false,
                loc: loc.clone(),
            }]
        };
        // Advance before the source body so `continue` cannot skip the cursor.
        body.push(Stmt::Assign {
            local_id: index.id.clone(),
            value: binary("+", read(&index, &loc), number(1.0, &loc), &loc),
            initializes_global: false,
            loc: loc.clone(),
        });
        body.extend(self.statement(node.statement())?);
        self.bindings = saved_bindings;
        self.var_types = saved_var_types;
        self.var_defined = stable_facts;

        Ok(vec![Stmt::Block {
            body: vec![
                Stmt::VarDecl {
                    local_id: source.id.clone(),
                    init: value,
                    loc: loc.clone(),
                },
                Stmt::VarDecl {
                    local_id: keys.id,
                    init: Expr::LibCall {
                        r#fn: "dyn.objKeys".into(),
                        args: vec![read(&source, &loc)],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::VarDecl {
                    local_id: index.id.clone(),
                    init: number(0.0, &loc),
                    loc: loc.clone(),
                },
                Stmt::While {
                    cond: binary("<", read(&index, &loc), length, &loc),
                    body,
                    loc: loc.clone(),
                },
            ],
            loc,
        }])
    }

    pub(super) fn for_of_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let asynchronous = !node.await_modifier().is_nil();
        let head = node.initializer();
        if head.kind() != SyntaxKind::VariableDeclarationList
            || !head.flags().intersects(NodeFlags::LET | NodeFlags::CONST)
        {
            return Err(self.refuse(head, "for-of requires a lexical let/const binding; var and assignment heads are not ported"));
        }
        let declarations = head.declarations().nodes().into_iter().collect::<Vec<_>>();
        if declarations.len() != 1
            || !matches!(
                declarations[0].name().kind(),
                SyntaxKind::Identifier
                    | SyntaxKind::ArrayBindingPattern
                    | SyntaxKind::ObjectBindingPattern
            )
            || !declarations[0].initializer().is_nil()
            || !declarations[0].type_().is_nil()
        {
            return Err(self.refuse(
                head,
                "for-of requires one identifier or flat array/object binding",
            ));
        }
        let declaration = declarations[0];
        if declaration.name().kind() == SyntaxKind::ArrayBindingPattern {
            self.validate_array_pattern(declaration.name())?;
        }
        let loc = self.loc(node);
        let stream_snapshot = asynchronous && self.fs_read_stream_origin(node.expression());
        let process_stdin = asynchronous && self.process_member(node.expression(), "stdin");
        let expression_type = self.checker.get_type_at_location(node.expression());
        let web_stream = asynchronous && self.web_stream_owning_type(expression_type);
        if !asynchronous
            && let Some(source) = self.set_iterator_source(node.expression())?
            && let Type::Set { elem } = source.ty()
        {
            return self.set_for_of(node, declaration, head, source, *elem);
        }
        if !asynchronous
            && let Some(iterator) = self.immediate_map_values_iterator(node.expression())?
        {
            return self.live_generator_for_of(node, declaration, head, iterator, Type::Dyn);
        }
        let mut value = if let Some(iteration) = self.immediate_map_iteration(node.expression())? {
            iteration
        } else if let Some(iteration) = self.immediate_set_iteration(node.expression())? {
            iteration
        } else if let Some(iteration) = self.search_params_iteration_array(node.expression())? {
            iteration
        } else {
            self.primitive_operand(node.expression())?
        };
        if asynchronous && !stream_snapshot {
            return self.erased_for_await(
                node,
                declaration,
                head,
                value,
                web_stream,
                process_stdin,
            );
        }
        if let Some(generator) = self.synchronous_generator_argument(value.ty())
            && value.ty() != generator
        {
            // A flow-visible synchronous Iterable may retain an optional or
            // sync/async union in its owning slot. Check the live tag before
            // driving it; the selected generator handle itself is not copied.
            let dynamic = self.coerce(value, Type::Dyn, node.expression())?;
            value = self.coerce(dynamic, generator, node.expression())?;
        }
        if matches!(value.ty(), Type::Union { .. })
            && matches!(
                self.ty(node.expression()).ok(),
                Some(Type::Map { .. } | Type::Set { .. })
            )
        {
            // A nullable owning cell may be copied while flow analysis proves
            // its live value is a collection (for example a scratch Set that
            // is reset to null immediately after the copy). Select that
            // represented arm before materializing the native iteration
            // snapshot; a genuinely nullable runtime path remains rejected.
            value = self.narrowed(value, node.expression())?;
        }
        if let Type::Union { union_id } = value.ty() {
            let collections = self.unions[union_id]
                .arms
                .iter()
                .filter(|arm| matches!(arm, Type::Map { .. } | Type::Set { .. }))
                .cloned()
                .collect::<Vec<_>>();
            let only_nullish_other_arms = self.unions[union_id].arms.iter().all(|arm| {
                matches!(
                    arm,
                    Type::Map { .. } | Type::Set { .. } | Type::Null | Type::Undefined
                )
            });
            if let [collection] = collections.as_slice()
                && only_nullish_other_arms
            {
                // Preserve the JavaScript failure for a live nullish value,
                // but keep the represented collection ABI on the successful
                // path so iteration needs no generic iterator object.
                let dynamic = self.coerce(value, Type::Dyn, node.expression())?;
                value = self.coerce(dynamic, collection.clone(), node.expression())?;
            }
        }
        if matches!(value.ty(), Type::Map { .. }) {
            // The typed Map backend owns insertion-ordered entries. Materialize
            // those entries as fixed native tuples, then reuse the ordinary
            // sequence/destructuring path below. Map mutation during iteration
            // remains outside this snapshot contract.
            value = self.map_intrinsic(node.expression(), value, "entries", vec![])?;
        }
        if let Type::Set { elem } = value.ty() {
            return self.set_for_of(node, declaration, head, value, *elem);
        }
        if let Type::Generator {
            r#async: false,
            yield_type,
            next_type,
            ..
        } = value.ty()
        {
            if !matches!(*next_type, Type::Void | Type::Undefined | Type::Dyn) {
                return Err(self.refuse(
                    node.expression(),
                    "for-of cannot drive a generator that requires values through next()",
                ));
            }
            // Erased Iterable parameters can own a native Map iterator or an
            // array even when the checker projects their yield to a scalar.
            // Keep their live values; retain the ordinary generator path for
            // every other runtime iterable.
            let map_iterator = if let Expr::DynCheck { value: owner, .. } = &value
                && matches!(owner.as_ref(), Expr::VarRef { .. })
            {
                let source = owner.as_ref().clone();
                let iterator_type = Type::Generator {
                    r#async: false,
                    yield_type: Box::new(Type::Dyn),
                    return_type: Box::new(Type::Void),
                    next_type: Box::new(Type::Undefined),
                };
                let map_iterator =
                    self.coerce(source.clone(), iterator_type.clone(), node.expression())?;
                let array = self.coerce(
                    source.clone(),
                    Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                    node.expression(),
                )?;
                let array_iterator =
                    self.coerce(array, iterator_type.clone(), node.expression())?;
                let iterator = Expr::Ternary {
                    cond: Box::new(Expr::DynTest {
                        value: Box::new(source.clone()),
                        test: "array".into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    }),
                    then: Box::new(array_iterator),
                    else_: Box::new(map_iterator),
                    r#type: iterator_type,
                    loc: loc.clone(),
                };
                Some((
                    source,
                    self.live_generator_for_of(node, declaration, head, iterator, Type::Dyn)?,
                ))
            } else {
                None
            };
            // An async body can suspend inside the loop; GeneratorForOf has no
            // continuation shape. Drive the iterator with explicit next() calls
            // in one ordinary loop when no break/return leaves it early.
            if self.is_async_function && !loop_body_exits_early(node.statement()) {
                if let Some((_, live)) = map_iterator {
                    return Ok(live);
                }
                return self.live_generator_for_of(node, declaration, head, value, *yield_type);
            }
            let saved_bindings = self.bindings.clone();
            let saved_var_types = self.var_types.clone();
            let stable_facts = self.immutable_var_facts();
            self.var_defined = stable_facts.clone();
            let pattern = declaration.name();
            let binding_name = if pattern.kind() == SyntaxKind::Identifier {
                pattern.text().to_string()
            } else {
                "generator iteration value".into()
            };
            let binding = self.iteration_local(
                &binding_name,
                (*yield_type).clone(),
                !head.flags().intersects(NodeFlags::CONST),
            );
            let mutable = !head.flags().intersects(NodeFlags::CONST);
            let mut body = if pattern.kind() == SyntaxKind::ObjectBindingPattern {
                self.bind_object_iteration(pattern, read(&binding, &self.loc(pattern)), mutable)?
            } else if pattern.kind() == SyntaxKind::ArrayBindingPattern {
                self.bind_sequence_pattern_value(
                    pattern,
                    (read(&binding, &self.loc(pattern)), (*yield_type).clone()),
                    mutable,
                    false,
                    None,
                )?
            } else if pattern.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(pattern);
                self.bindings.insert(symbol, binding.clone());
                if self.optional_storage(&binding.r#type) {
                    self.var_types.insert(symbol, binding.r#type.clone());
                }
                Vec::new()
            } else {
                return Err(self.refuse(
                    pattern,
                    "generator for-of requires an identifier, object or array binding",
                ));
            };
            body.extend(self.statement(node.statement())?);
            self.bindings = saved_bindings;
            self.var_types = saved_var_types;
            self.var_defined = stable_facts;
            let ordinary = vec![Stmt::GeneratorForOf {
                generator: value,
                local_id: binding.id,
                body,
                loc: loc.clone(),
            }];
            if let Some((source, live)) = map_iterator {
                return Ok(vec![Stmt::If {
                    cond: Expr::Logical {
                        op: "||".into(),
                        left: Box::new(Expr::DynTest {
                            value: Box::new(source.clone()),
                            test: "mapValuesIterator".into(),
                            negated: false,
                            r#type: Type::Bool,
                            loc: loc.clone(),
                        }),
                        right: Box::new(Expr::DynTest {
                            value: Box::new(source),
                            test: "array".into(),
                            negated: false,
                            r#type: Type::Bool,
                            loc: loc.clone(),
                        }),
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    then: live,
                    else_: Some(ordinary),
                    loc,
                }]);
            }
            return Ok(ordinary);
        }
        if matches!(value.ty(), Type::Dyn | Type::Union { .. }) {
            return self.erased_for_of(node, declaration, head, value);
        }
        if matches!(value.ty(), Type::Object { .. }) {
            self.materialize_erased_symbol_methods(&value.ty())?;
            let value = self.coerce(value, Type::Dyn, node.expression())?;
            return self.erased_for_of(node, declaration, head, value);
        }
        let (element, length) = match value.ty() {
            Type::Array { elem } => (*elem, None),
            Type::Bytes { .. } => (Type::F64, None),
            Type::String => (Type::String, None),
            Type::Record { shape_id } if self.records[shape_id].tuple => {
                let fields = self.records[shape_id].fields.clone();
                if fields.is_empty() {
                    return Err(self.refuse(node, "empty-tuple for-of needs an unreachable binding contract"));
                }
                let types = fields.iter().map(|field| field.r#type.clone()).collect::<Vec<_>>();
                let element = self.intern_union(types).ok_or_else(|| self.refuse(node, "tuple iteration elements have no shared native value contract"))?;
                (element, Some(fields.len()))
            }
            other => return Err(self.refuse(node.expression(), &format!("for-of requires a standard array, tuple, typed array, string or represented generator; got {other:?}; custom iterators are not ported"))),
        };
        let source = self.iteration_local("iteration source", value.ty(), false);
        let index = self.iteration_local("iteration index", Type::F64, true);
        let mut outer = vec![
            Stmt::VarDecl {
                local_id: source.id.clone(),
                init: value,
                loc: loc.clone(),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: number(0.0, &loc),
                loc: loc.clone(),
            },
        ];
        let saved_bindings = self.bindings.clone();
        let saved_var_types = self.var_types.clone();
        let stable_facts = self.immutable_var_facts();
        self.var_defined = stable_facts.clone();
        let mut step = number(1.0, &loc);
        let item = match source.r#type {
            Type::String => {
                step = self.string_iteration_width(read(&source, &loc), read(&index, &loc), node);
                Expr::StringIntrinsic {
                    method: "slice".into(),
                    receiver: Box::new(read(&source, &loc)),
                    args: vec![
                        read(&index, &loc),
                        binary("+", read(&index, &loc), step.clone(), &loc),
                    ],
                    r#type: Type::String,
                    loc: loc.clone(),
                }
            }
            Type::Record { shape_id } => {
                let fields = self.records[shape_id].fields.clone();
                let mut item = None;
                for field in fields {
                    let slot = Expr::RecordGet {
                        obj: Box::new(read(&source, &loc)),
                        shape_id: format!("r{shape_id}"),
                        field: field.name.clone(),
                        r#type: field.r#type,
                        loc: loc.clone(),
                    };
                    let slot = self.coerce(slot, element.clone(), node)?;
                    item = Some(match item {
                        None => slot,
                        Some(other) => Expr::Ternary {
                            cond: Box::new(binary(
                                "===",
                                read(&index, &loc),
                                number(field.name.parse().unwrap(), &loc),
                                &loc,
                            )),
                            then: Box::new(slot),
                            else_: Box::new(other),
                            r#type: element.clone(),
                            loc: loc.clone(),
                        },
                    });
                }
                item.expect("non-empty tuple")
            }
            Type::Bytes { .. } => self.bytes_operation(
                node,
                read(&source, &loc),
                "get",
                vec![read(&index, &loc)],
                Type::F64,
            ),
            _ => {
                let object = self.coerce(read(&source, &loc), Type::Dyn, node)?;
                let key = Expr::ToString {
                    operand: Box::new(read(&index, &loc)),
                    r#type: Type::String,
                    loc: loc.clone(),
                };
                let item = self.dynamic_get(node, object, key);
                if declaration.name().kind() == SyntaxKind::ArrayBindingPattern {
                    item
                } else {
                    self.coerce(item, element.clone(), node)?
                }
            }
        };
        let mut body = if declaration.name().kind() == SyntaxKind::ObjectBindingPattern {
            self.bind_object_iteration(
                declaration.name(),
                item,
                !head.flags().intersects(NodeFlags::CONST),
            )?
        } else if declaration.name().kind() == SyntaxKind::ArrayBindingPattern {
            self.bind_sequence_pattern_value(
                declaration.name(),
                (item, element.clone()),
                !head.flags().intersects(NodeFlags::CONST),
                false,
                None,
            )?
        } else {
            let binding = self.iteration_local(
                declaration.name().text(),
                element.clone(),
                !head.flags().intersects(NodeFlags::CONST),
            );
            let symbol = self.symbol(declaration.name());
            self.bindings.insert(symbol, binding.clone());
            if self.optional_storage(&element) {
                self.var_types.insert(symbol, element);
            }
            vec![Stmt::VarDecl {
                local_id: binding.id,
                init: item,
                loc: loc.clone(),
            }]
        };
        // Fresh head cells execute inside each iteration, before advancing.
        body.push(Stmt::Assign {
            local_id: index.id.clone(),
            value: binary("+", read(&index, &loc), step, &loc),
            initializes_global: false,
            loc: loc.clone(),
        });
        body.extend(self.statement(node.statement())?);
        let length = match length {
            Some(length) => number(length as f64, &loc),
            None if source.r#type == Type::String => Expr::StringIntrinsic {
                method: "length".into(),
                receiver: Box::new(read(&source, &loc)),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            None if matches!(source.r#type, Type::Bytes { .. }) => Expr::BytesIntrinsic {
                method: "length".into(),
                receiver: Box::new(read(&source, &loc)),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            None => Expr::ArrayIntrinsic {
                method: "length".into(),
                receiver: Box::new(read(&source, &loc)),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
        };
        outer.push(Stmt::While {
            cond: binary("<", read(&index, &loc), length, &loc),
            body,
            loc: loc.clone(),
        });
        self.bindings = saved_bindings;
        self.var_types = saved_var_types;
        self.var_defined = stable_facts;
        Ok(vec![Stmt::Block { body: outer, loc }])
    }

    /// Lower the async-iterator protocol to ordinary IR suspension points. The
    /// iterator and each step are evaluated exactly once; the backend resumes
    /// this loop after the `next()` promise settles.
    fn erased_for_await(
        &mut self,
        node: Node,
        declaration: Node,
        head: Node,
        value: Expr,
        web_stream: bool,
        process_stdin: bool,
    ) -> Result<Vec<Stmt>, String> {
        if !self.is_async_function {
            return Err(self.refuse(node, "for-await requires an async function body"));
        }
        let loc = self.loc(node);
        let source = self.coerce(value, Type::Dyn, node.expression())?;
        let iterator = self.iteration_local("async iterator", Type::Dyn, false);
        let active = self.iteration_local("async iterator active", Type::Bool, true);
        let item_type = if process_stdin {
            Type::bytes()
        } else {
            Type::Dyn
        };
        let step = self.iteration_local("async iterator step", item_type.clone(), false);
        let binding = self.iteration_local(
            if declaration.name().kind() == SyntaxKind::Identifier {
                declaration.name().text()
            } else {
                "async iterator value".into()
            },
            item_type.clone(),
            !head.flags().intersects(NodeFlags::CONST),
        );

        let saved_bindings = self.bindings.clone();
        let saved_var_types = self.var_types.clone();
        let stable_facts = self.immutable_var_facts();
        self.var_defined = stable_facts.clone();
        let mut binding_body = match declaration.name().kind() {
            SyntaxKind::ObjectBindingPattern => self.bind_object_iteration(
                declaration.name(),
                read(&binding, &loc),
                !head.flags().intersects(NodeFlags::CONST),
            )?,
            SyntaxKind::ArrayBindingPattern => self.bind_sequence_pattern_value(
                declaration.name(),
                (read(&binding, &loc), Type::Dyn),
                !head.flags().intersects(NodeFlags::CONST),
                false,
                None,
            )?,
            SyntaxKind::Identifier => {
                let symbol = self.symbol(declaration.name());
                self.bindings.insert(symbol, binding.clone());
                self.var_types.insert(symbol, item_type.clone());
                Vec::new()
            }
            _ => {
                return Err(self.refuse(
                    declaration.name(),
                    "for-await requires an identifier or binding pattern",
                ));
            }
        };
        let mut source_body = self.statement(node.statement())?;
        self.bindings = saved_bindings;
        self.var_types = saved_var_types;
        self.var_defined = stable_facts;
        let (awaited, done, item) = if process_stdin {
            let awaited = Expr::Await {
                value: Box::new(Expr::LibCall {
                    r#fn: "process.stdinNext".into(),
                    args: vec![],
                    r#type: Type::Promise {
                        inner: Box::new(Type::bytes()),
                    },
                    loc: loc.clone(),
                }),
                r#type: Type::bytes(),
                loc: loc.clone(),
            };
            let done = Expr::Bin {
                op: "===".into(),
                left: Box::new(Expr::BytesIntrinsic {
                    method: "length".into(),
                    receiver: Box::new(read(&step, &loc)),
                    args: vec![],
                    r#type: Type::F64,
                    loc: loc.clone(),
                }),
                right: Box::new(number(0.0, &loc)),
                r#type: Type::Bool,
                loc: loc.clone(),
            };
            (awaited, done, read(&step, &loc))
        } else {
            let next = Expr::DynInvoke {
                recv: Box::new(read(&iterator, &loc)),
                method: if web_stream { "read" } else { "next" }.into(),
                callee_name: if web_stream {
                    "ReadableStreamDefaultReader.read"
                } else {
                    "AsyncIterator.next"
                }
                .into(),
                optional: false,
                args: vec![],
                r#type: Type::Dyn,
                loc: loc.clone(),
            };
            let promise_type = Type::Promise {
                inner: Box::new(Type::Dyn),
            };
            let awaited = Expr::Await {
                value: Box::new(self.coerce(next, promise_type, node)?),
                r#type: Type::Dyn,
                loc: loc.clone(),
            };
            let done = self.coerce(
                self.dynamic_get(
                    node,
                    read(&step, &loc),
                    Expr::StrLit {
                        value: "done".into(),
                        r#type: Type::String,
                        loc: loc.clone(),
                    },
                ),
                Type::Bool,
                node,
            )?;
            let item = self.dynamic_get(
                node,
                read(&step, &loc),
                Expr::StrLit {
                    value: "value".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                },
            );
            (awaited, done, item)
        };
        // AsyncIteratorClose runs after the body has produced a throw, but
        // before that error escapes. PromiseResolve also handles an optional
        // missing `return` method without inventing a synchronous special
        // case. A failed close replaces the original error, as JavaScript
        // requires.
        let close_call = Expr::DynInvoke {
            recv: Box::new(read(&iterator, &loc)),
            method: if web_stream { "cancel" } else { "return" }.into(),
            callee_name: if web_stream {
                "ReadableStreamDefaultReader.cancel"
            } else {
                "AsyncIterator.return"
            }
            .into(),
            optional: !web_stream,
            args: vec![],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let close = if process_stdin {
            Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "process.stdinPause".into(),
                    args: vec![],
                    r#type: Type::Void,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }
        } else {
            Stmt::Expression {
                expr: Expr::Await {
                    value: Box::new(Expr::Intrinsic {
                        name: "promise.resolve".into(),
                        args: vec![close_call],
                        r#type: Type::Promise {
                            inner: Box::new(Type::Dyn),
                        },
                        loc: loc.clone(),
                    }),
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }
        };
        let mut break_close = vec![Stmt::Assign {
            local_id: active.id.clone(),
            value: Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            initializes_global: false,
            loc: loc.clone(),
        }];
        break_close.push(close.clone());
        if web_stream {
            break_close.push(Stmt::Expression {
                expr: Expr::DynInvoke {
                    recv: Box::new(read(&iterator, &loc)),
                    method: "releaseLock".into(),
                    callee_name: "ReadableStreamDefaultReader.releaseLock".into(),
                    optional: false,
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            });
        }
        close_iteration_breaks(&mut source_body, 0, &break_close);
        if iteration_requires_close(&source_body, 0) {
            return Err(self.refuse(
                node,
                "for-await return completion requires AsyncIteratorClose lowering",
            ));
        }
        let mut present = vec![Stmt::VarDecl {
            local_id: binding.id,
            init: item,
            loc: loc.clone(),
        }];
        present.append(&mut binding_body);
        present.extend(source_body);
        let caught = self.iteration_local("async iterator body error", Type::Caught, false);
        let mut catch_body = vec![Stmt::If {
            cond: read(&active, &loc),
            then: vec![close],
            else_: None,
            loc: loc.clone(),
        }];
        if web_stream {
            catch_body.push(Stmt::Expression {
                expr: Expr::DynInvoke {
                    recv: Box::new(read(&iterator, &loc)),
                    method: "releaseLock".into(),
                    callee_name: "ReadableStreamDefaultReader.releaseLock".into(),
                    optional: false,
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            });
        }
        catch_body.push(Stmt::Throw {
            value: Expr::CaughtToDyn {
                value: Box::new(read(&caught, &loc)),
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        });
        let present = vec![Stmt::TryCatch {
            try_body: present,
            catch_body: Some(catch_body),
            catch_local_id: Some(caught.id),
            finally_body: None,
            loc: loc.clone(),
        }];
        let mut complete = vec![Stmt::Assign {
            local_id: active.id.clone(),
            value: Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            initializes_global: false,
            loc: loc.clone(),
        }];
        if web_stream {
            complete.push(Stmt::Expression {
                expr: Expr::DynInvoke {
                    recv: Box::new(read(&iterator, &loc)),
                    method: "releaseLock".into(),
                    callee_name: "ReadableStreamDefaultReader.releaseLock".into(),
                    optional: false,
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            });
        }
        let loop_body = vec![
            Stmt::VarDecl {
                local_id: step.id,
                init: awaited,
                loc: loc.clone(),
            },
            Stmt::If {
                cond: done,
                then: complete,
                else_: Some(present),
                loc: loc.clone(),
            },
        ];
        Ok(vec![Stmt::Block {
            body: vec![
                Stmt::VarDecl {
                    local_id: iterator.id,
                    init: if process_stdin {
                        source
                    } else if web_stream {
                        Expr::DynInvoke {
                            recv: Box::new(source),
                            method: "getReader".into(),
                            callee_name: "ReadableStream.getReader".into(),
                            optional: false,
                            args: vec![],
                            r#type: Type::Dyn,
                            loc: loc.clone(),
                        }
                    } else {
                        Expr::LibCall {
                            r#fn: "dyn.asyncIterator".into(),
                            args: vec![source],
                            r#type: Type::Dyn,
                            loc: loc.clone(),
                        }
                    },
                    loc: loc.clone(),
                },
                Stmt::VarDecl {
                    local_id: active.id.clone(),
                    init: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::While {
                    cond: read(&active, &loc),
                    body: loop_body,
                    loc: loc.clone(),
                },
            ],
            loc,
        }])
    }

    fn set_for_of(
        &mut self,
        node: Node,
        declaration: Node,
        head: Node,
        value: Expr,
        _element: Type,
    ) -> Result<Vec<Stmt>, String> {
        let loc = self.loc(node);
        let iterator_ty = Type::Generator {
            r#async: false,
            yield_type: Box::new(Type::Dyn),
            return_type: Box::new(Type::Void),
            next_type: Box::new(Type::Undefined),
        };
        let iterator = Expr::SetIntrinsic {
            method: "dynamicIterator".into(),
            receiver: Box::new(value),
            args: vec![],
            r#type: iterator_ty,
            loc,
        };
        self.live_generator_for_of(node, declaration, head, iterator, Type::Dyn)
    }

    fn live_generator_for_of(
        &mut self,
        node: Node,
        declaration: Node,
        head: Node,
        source: Expr,
        element: Type,
    ) -> Result<Vec<Stmt>, String> {
        let loc = self.loc(node);
        let iterator = self.iteration_local("collection iterator", source.ty(), false);
        let step = self.iteration_local("collection iterator result", Type::Dyn, false);
        let initializer = Stmt::VarDecl {
            local_id: iterator.id.clone(),
            init: source,
            loc: loc.clone(),
        };
        let next = Stmt::VarDecl {
            local_id: step.id.clone(),
            init: Expr::GeneratorNext {
                generator: Box::new(read(&iterator, &loc)),
                value: Box::new(Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: loc.clone(),
                }),
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        };
        let done = self.dynamic_get(
            node,
            read(&step, &loc),
            Expr::StrLit {
                value: "done".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let item = self.dynamic_get(
            node,
            read(&step, &loc),
            Expr::StrLit {
                value: "value".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let item = self.coerce(item, element.clone(), node)?;
        let saved_bindings = self.bindings.clone();
        let saved_var_types = self.var_types.clone();
        let stable_facts = self.immutable_var_facts();
        self.var_defined = stable_facts.clone();
        let mut body = vec![
            next,
            Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(done),
                    test: "truthy".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
                then: vec![Stmt::Break {
                    target_depth: 0,
                    loc: loc.clone(),
                }],
                else_: None,
                loc: loc.clone(),
            },
        ];
        let mutable = !head.flags().intersects(NodeFlags::CONST);
        if declaration.name().kind() == SyntaxKind::ObjectBindingPattern {
            body.extend(self.bind_object_iteration(declaration.name(), item, mutable)?);
        } else if declaration.name().kind() == SyntaxKind::ArrayBindingPattern {
            body.extend(self.bind_sequence_pattern_value(
                declaration.name(),
                (item, element.clone()),
                mutable,
                false,
                None,
            )?);
        } else {
            let binding = self.iteration_local(declaration.name().text(), element.clone(), mutable);
            let symbol = self.symbol(declaration.name());
            self.bindings.insert(symbol, binding.clone());
            if self.optional_storage(&element) {
                self.var_types.insert(symbol, element);
            }
            body.push(Stmt::VarDecl {
                local_id: binding.id,
                init: item,
                loc: loc.clone(),
            });
        }
        body.extend(self.statement(node.statement())?);
        self.bindings = saved_bindings;
        self.var_types = saved_var_types;
        self.var_defined = stable_facts;
        Ok(vec![Stmt::Block {
            body: vec![
                initializer,
                Stmt::While {
                    cond: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    body,
                    loc: loc.clone(),
                },
            ],
            loc,
        }])
    }

    /// Keep the owning source and live cursor in the enclosing loop. Standard
    /// sequences have no user close hook; the body retains its own completions.
    fn erased_for_of(
        &mut self,
        node: Node,
        declaration: Node,
        head: Node,
        value: Expr,
    ) -> Result<Vec<Stmt>, String> {
        if self.native_type_contains(&value.ty(), |ty| {
            matches!(ty, Type::Map { .. } | Type::Set { .. })
        }) {
            return Err(self.refuse(node.expression(), "Map/Set for-of iterators are not ported"));
        }
        let loc = self.loc(node);
        let value = self.coerce(value, Type::Dyn, node)?;
        let source = self.iteration_local("iteration source", Type::Dyn, false);
        let index = self.iteration_local("iteration index", Type::F64, true);
        let mut outer = vec![
            Stmt::VarDecl {
                local_id: source.id.clone(),
                init: value,
                loc: loc.clone(),
            },
            // Validate the source even when it is empty. No prefix of the input
            // is materialized: subsequent reads observe live array mutations.
            Stmt::Expression {
                expr: Expr::DynIterN {
                    value: Box::new(read(&source, &loc)),
                    count: 0,
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: number(0.0, &loc),
                loc: loc.clone(),
            },
        ];
        let is_string = Expr::DynTest {
            value: Box::new(read(&source, &loc)),
            test: "string".into(),
            negated: false,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let string = Expr::DynCheck {
            value: Box::new(read(&source, &loc)),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let width = self.string_iteration_width(string.clone(), read(&index, &loc), node);
        let step = Expr::Ternary {
            cond: Box::new(is_string.clone()),
            then: Box::new(width.clone()),
            else_: Box::new(number(1.0, &loc)),
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let text = Expr::StringIntrinsic {
            method: "slice".into(),
            receiver: Box::new(string),
            args: vec![
                read(&index, &loc),
                binary("+", read(&index, &loc), width, &loc),
            ],
            r#type: Type::String,
            loc: loc.clone(),
        };
        let key = Expr::ToString {
            operand: Box::new(read(&index, &loc)),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let item = Expr::Ternary {
            cond: Box::new(is_string),
            then: Box::new(self.coerce(text, Type::Dyn, node)?),
            else_: Box::new(self.dynamic_get(node, read(&source, &loc), key)),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let saved_bindings = self.bindings.clone();
        let saved_var_types = self.var_types.clone();
        let stable_facts = self.immutable_var_facts();
        self.var_defined = stable_facts.clone();
        let pattern = declaration.name();
        let mutable = !head.flags().intersects(NodeFlags::CONST);
        let binding = self.iteration_local(
            if pattern.kind() == SyntaxKind::Identifier {
                pattern.text()
            } else {
                "dynamic iteration value"
            },
            Type::Dyn,
            mutable,
        );
        let pattern_body = if pattern.kind() == SyntaxKind::ObjectBindingPattern {
            self.bind_object_iteration(pattern, read(&binding, &loc), mutable)?
        } else if pattern.kind() == SyntaxKind::ArrayBindingPattern {
            self.bind_sequence_pattern(pattern, read(&binding, &loc), mutable, false, None)?
        } else {
            let symbol = self.symbol(pattern);
            self.bindings.insert(symbol, binding.clone());
            self.var_types.insert(symbol, Type::Dyn);
            Vec::new()
        };
        let source_body = self.statement(node.statement())?;
        let mut sequence_body = vec![Stmt::VarDecl {
            local_id: binding.id.clone(),
            init: item,
            loc: loc.clone(),
        }];
        sequence_body.extend(pattern_body.clone());
        sequence_body.push(Stmt::Assign {
            local_id: index.id.clone(),
            value: binary("+", read(&index, &loc), step, &loc),
            initializes_global: false,
            loc: loc.clone(),
        });
        sequence_body.extend(source_body.clone());
        let mut iterator_body = pattern_body;
        iterator_body.extend(source_body);
        let length = self.dynamic_get(
            node,
            read(&source, &loc),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let length = self.coerce(length, Type::F64, node)?;
        outer.push(Stmt::While {
            cond: binary("<", read(&index, &loc), length, &loc),
            body: sequence_body,
            loc: loc.clone(),
        });
        self.bindings = saved_bindings;
        self.var_types = saved_var_types;
        self.var_defined = stable_facts;
        // When the checker proves every constituent is an Array, the live value
        // cannot be a generator or class iterator: iterate it by index only.
        // A single path also lets an async body suspend inside the loop.
        let checked = self.checker.get_type_at_location(node.expression());
        let array_only = self.checker.is_array_type(checked)
            || (self.checker.ty(checked).flags.intersects(TypeFlags::UNION)
                && self
                    .checker
                    .ty(checked)
                    .types()
                    .to_vec()
                    .into_iter()
                    .all(|arm| self.checker.is_array_type(arm)));
        if array_only {
            return Ok(vec![Stmt::Block {
                body: outer,
                loc: loc.clone(),
            }]);
        }
        let source_declaration = outer.remove(0);
        let class_iterator = Expr::DynInvoke {
            recv: Box::new(read(&source, &loc)),
            method: "\0sym.iterator".into(),
            callee_name: "Symbol.iterator".into(),
            optional: false,
            args: vec![],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let iterator_source = Expr::Ternary {
            cond: Box::new(Expr::DynTest {
                value: Box::new(read(&source, &loc)),
                test: "classIterable".into(),
                negated: false,
                r#type: Type::Bool,
                loc: loc.clone(),
            }),
            then: Box::new(class_iterator),
            else_: Box::new(read(&source, &loc)),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let iterator = self.coerce(
            iterator_source,
            Type::Generator {
                r#async: false,
                yield_type: Box::new(Type::Dyn),
                return_type: Box::new(Type::Void),
                next_type: Box::new(Type::Undefined),
            },
            node.expression(),
        )?;
        // An async body can suspend inside the loop. GeneratorForOf has no
        // continuation shape, so drive the iterator with explicit next()
        // calls in an ordinary loop. Only bodies without break/return use
        // this form: those are the early exits that would have to close the
        // iterator, and neither form closes it on them.
        let generator_branch = if self.is_async_function {
            let iterator_local = self.iteration_local("erased iterator", iterator.ty(), false);
            let step_local = self.iteration_local("erased iterator step", Type::Dyn, false);
            let step_read = read(&step_local, &loc);
            let key = |name: &str| Expr::StrLit {
                value: name.into(),
                r#type: Type::String,
                loc: loc.clone(),
            };
            let done = self.dynamic_get(node, step_read.clone(), key("done"));
            let value = self.dynamic_get(node, step_read, key("value"));
            let mut loop_body = vec![
                Stmt::VarDecl {
                    local_id: step_local.id.clone(),
                    init: Expr::GeneratorNext {
                        generator: Box::new(read(&iterator_local, &loc)),
                        value: Box::new(Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::If {
                    cond: Expr::DynTest {
                        value: Box::new(done),
                        test: "truthy".into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    then: vec![Stmt::Break {
                        target_depth: 0,
                        loc: loc.clone(),
                    }],
                    else_: None,
                    loc: loc.clone(),
                },
                Stmt::VarDecl {
                    local_id: binding.id.clone(),
                    init: value,
                    loc: loc.clone(),
                },
            ];
            let close = Stmt::Expression {
                expr: Expr::GeneratorReturn {
                    generator: Box::new(read(&iterator_local, &loc)),
                    value: None,
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            };
            loop_body.extend(close_before_exits(iterator_body, &close, 0, 0));
            vec![
                Stmt::VarDecl {
                    local_id: iterator_local.id.clone(),
                    init: iterator,
                    loc: loc.clone(),
                },
                Stmt::While {
                    cond: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    body: loop_body,
                    loc: loc.clone(),
                },
            ]
        } else {
            vec![Stmt::GeneratorForOf {
                generator: iterator,
                local_id: binding.id,
                body: iterator_body,
                loc: loc.clone(),
            }]
        };
        let brand = |test: &str| Expr::DynTest {
            value: Box::new(read(&source, &loc)),
            test: test.into(),
            negated: false,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        Ok(vec![Stmt::Block {
            body: vec![
                source_declaration,
                Stmt::If {
                    cond: Expr::Logical {
                        op: "||".into(),
                        left: Box::new(Expr::Logical {
                            op: "||".into(),
                            left: Box::new(brand("syncGenerator")),
                            right: Box::new(brand("classIterable")),
                            r#type: Type::Bool,
                            loc: loc.clone(),
                        }),
                        right: Box::new(brand("mapValuesIterator")),
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    then: generator_branch,
                    else_: Some(outer),
                    loc: loc.clone(),
                },
            ],
            loc,
        }])
    }

    pub(super) fn string_iteration_width(&mut self, value: Expr, index: Expr, node: Node) -> Expr {
        let mut helper = Helper::new(
            "string_iteration_width",
            vec![Type::String, Type::F64],
            Type::F64,
            self.loc(node),
        );
        let loc = helper.loc();
        let code = |index| Expr::StringIntrinsic {
            method: "charCodeAt".into(),
            receiver: Box::new(helper.read(&helper.param(0))),
            args: vec![index],
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let first = code(helper.read(&helper.param(1)));
        let second = code(binary(
            "+",
            helper.read(&helper.param(1)),
            number(1.0, &loc),
            &loc,
        ));
        let range = |value: Expr, low, high| Expr::Logical {
            op: "&&".into(),
            left: Box::new(binary(">=", value.clone(), number(low, &loc), &loc)),
            right: Box::new(binary("<=", value, number(high, &loc), &loc)),
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let pair = Expr::Logical {
            op: "&&".into(),
            left: Box::new(range(first, 55296.0, 56319.0)),
            right: Box::new(range(second, 56320.0, 57343.0)),
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::Ternary {
                cond: Box::new(pair),
                then: Box::new(number(2.0, &loc)),
                else_: Box::new(number(1.0, &loc)),
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            loc,
        });
        Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![value, index],
            r#type: Type::F64,
            loc: self.loc(node),
        }
    }
}

/// Whether a loop body can leave the loop through `break` or `return`
/// (excluding nested functions, which own their completions).
fn loop_body_exits_early(node: Node) -> bool {
    if matches!(node.kind(), SyntaxKind::BreakStatement | SyntaxKind::ReturnStatement) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child: Node| {
        if !matches!(
            child.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
        ) {
            found = found || loop_body_exits_early(child);
        }
        found
    });
    found
}

/// Insert `close` before every completion that leaves the iteration loop —
/// `return`, a `break` of this loop or an outer target, and a `continue` of an
/// outer loop — matching GeneratorForOf's iterator close on abrupt exits.
/// `breaks` counts loops and switches nested in the body, `continues` loops.
fn close_before_exits(body: Vec<Stmt>, close: &Stmt, breaks: usize, continues: usize) -> Vec<Stmt> {
    let mut out = Vec::with_capacity(body.len());
    for stmt in body {
        match stmt {
            Stmt::Return { .. } => {
                out.push(close.clone());
                out.push(stmt);
            }
            Stmt::Break { target_depth, .. } if target_depth >= breaks => {
                out.push(close.clone());
                out.push(stmt);
            }
            Stmt::Continue { target_depth, .. } if target_depth > continues => {
                out.push(close.clone());
                out.push(stmt);
            }
            Stmt::If { cond, then, else_, loc } => out.push(Stmt::If {
                cond,
                then: close_before_exits(then, close, breaks, continues),
                else_: else_.map(|body| close_before_exits(body, close, breaks, continues)),
                loc,
            }),
            Stmt::Block { body, loc } => out.push(Stmt::Block {
                body: close_before_exits(body, close, breaks, continues),
                loc,
            }),
            Stmt::TryCatch {
                try_body,
                catch_body,
                catch_local_id,
                finally_body,
                loc,
            } => out.push(Stmt::TryCatch {
                try_body: close_before_exits(try_body, close, breaks, continues),
                catch_body: catch_body.map(|body| close_before_exits(body, close, breaks, continues)),
                catch_local_id,
                finally_body: finally_body.map(|body| close_before_exits(body, close, breaks, continues)),
                loc,
            }),
            Stmt::While { cond, body, loc } => out.push(Stmt::While {
                cond,
                body: close_before_exits(body, close, breaks + 1, continues + 1),
                loc,
            }),
            Stmt::GeneratorForOf {
                generator,
                local_id,
                body,
                loc,
            } => out.push(Stmt::GeneratorForOf {
                generator,
                local_id,
                body: close_before_exits(body, close, breaks + 1, continues + 1),
                loc,
            }),
            Stmt::Switch { disc, cases, loc } => out.push(Stmt::Switch {
                disc,
                cases: cases
                    .into_iter()
                    .map(|mut case| {
                        case.body = close_before_exits(std::mem::take(&mut case.body), close, breaks + 1, continues);
                        case
                    })
                    .collect(),
                loc,
            }),
            other => out.push(other),
        }
    }
    out
}
