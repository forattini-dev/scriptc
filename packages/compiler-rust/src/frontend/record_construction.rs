//! A private construction plan snapshots values before publishing a typed record.
use super::*;
use source_frontend::flags::ContextFlags;

struct Slot {
    name: String,
    ty: Type,
    value: Local,
    inputs: Vec<Expr>,
}
struct Plan {
    slots: Vec<Slot>,
    own: Local,
    assign: bool,
    dynamic: bool,
}

impl Lowerer<'_> {
    fn construction_dynamic_owner(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if matches!(value.ty(), Type::Record { .. }) {
            // Object spread needs a temporary view of only the record's own
            // property store.  It does not erase nested field contracts or
            // dispatch through their prototype symbol methods.  Reuse the
            // identity-preserving record view already used by computed record
            // updates instead of granting a general DynFrom conversion.
            return Ok(Expr::LibCall {
                r#fn: "record.mutableDynView".into(),
                args: vec![value],
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        self.coerce(value, Type::Dyn, node)
    }

    fn construction_own_value(&self, value: Expr, node: Node) -> Result<Expr, String> {
        if self.dynamic_erasure_reason(&value.ty())
            == Some("erasing symbol methods requires a native descriptor contract")
        {
            // The construction backing store retains this value only as an
            // own data-property payload.  Copying it neither dispatches nor
            // advertises its prototype symbol methods; the typed record slot
            // remains the contract used by represented consumers.  Preserve
            // the native identity without granting the general Dyn erasure
            // that dynamic symbol calls would require.
            return Ok(Expr::LibCall {
                r#fn: "record.opaqueOwnValue".into(),
                args: vec![value],
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        self.coerce(value, Type::Dyn, node)
    }

    pub(super) fn construct_dictionary_spread(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            unreachable!("dictionary construction target")
        };
        let target_value = self.records[shape_id]
            .index_value
            .clone()
            .expect("dictionary construction value");
        if !self.records[shape_id].fields.is_empty() {
            // Mixed records combine named field contracts with an open index
            // store. Build the JavaScript object once with ordinary spread
            // order, then attach the checked shared view; Dyn is still our
            // native Rust value ABI and retains every own key and identity.
            let value = self.dynamic_literal(node)?;
            return self.coerce(value, target, node);
        }

        let output = self.construction_local(target.clone(), false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: output.id.clone(),
            init: Expr::RecordLit {
                fields: vec![],
                null_prototype: false,
                r#type: target.clone(),
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];

        for property in properties {
            if property.kind() != SyntaxKind::SpreadAssignment {
                if !matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                ) {
                    return Err(self.refuse(property, "dictionary spread requires data properties"));
                }
                let key = if property.name().kind() == SyntaxKind::ComputedPropertyName {
                    self.property_key_expression(property.name().expression())?
                } else {
                    let name = self.data_property_name(property.name()).ok_or_else(|| {
                        self.refuse(property, "dictionary property key is not represented")
                    })?;
                    if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                        return Err(
                            self.refuse(property, "object prototype setters are not ported")
                        );
                    }
                    Expr::StrLit {
                        value: name,
                        r#type: Type::String,
                        loc: self.loc(property),
                    }
                };
                let value = self.object_property_value(property, target_value.clone())?;
                stmts.push(Stmt::RecordKeySet {
                    obj: self.construction_read(&output, property),
                    shape_id: format!("r{shape_id}"),
                    key,
                    value,
                    overflow_only: true,
                    loc: self.loc(property),
                });
                continue;
            }

            let source_node = property.expression();
            let source_value = self.expression(source_node)?;
            stmts.extend(self.dictionary_spread_value(
                source_node,
                property,
                &output,
                shape_id,
                &target_value,
                source_value,
            )?);
        }

        Ok(Expr::Sequence {
            stmts,
            result: Box::new(self.construction_read(&output, node)),
            r#type: target,
            loc: self.loc(node),
        })
    }

    fn dictionary_spread_value(
        &mut self,
        source_node: Node,
        property: Node,
        output: &Local,
        target_shape: usize,
        target_value: &Type,
        value: Expr,
    ) -> Result<Vec<Stmt>, String> {
        if matches!(value.ty(), Type::Null | Type::Undefined) {
            return Ok(Vec::new());
        }
        if let Type::Union { union_id } = value.ty() {
            let arms = self.unions[union_id].arms.clone();
            if arms.is_empty()
                || arms.iter().any(|arm| {
                    !matches!(
                        arm,
                        Type::Record { .. } | Type::Dyn | Type::Null | Type::Undefined
                    )
                })
            {
                return Err(self.refuse(
                    source_node,
                    "dictionary spread union needs object or nullish native arms",
                ));
            }
            let local = self.construction_local(value.ty(), false);
            let mut branches = Vec::new();
            for (tag, arm) in arms.into_iter().enumerate() {
                let narrowed = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(self.construction_read(&local, source_node)),
                    r#type: arm,
                    loc: self.loc(source_node),
                };
                branches.push(self.dictionary_spread_value(
                    source_node,
                    property,
                    output,
                    target_shape,
                    target_value,
                    narrowed,
                )?);
            }
            let mut tail = branches.pop().expect("non-empty dictionary spread union");
            while let Some(body) = branches.pop() {
                let tag = branches.len();
                tail = vec![Stmt::If {
                    cond: Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        value: Box::new(self.construction_read(&local, source_node)),
                        r#type: Type::Bool,
                        loc: self.loc(source_node),
                    },
                    then: body,
                    else_: Some(tail),
                    loc: self.loc(source_node),
                }];
            }
            let mut body = vec![Stmt::VarDecl {
                local_id: local.id,
                init: value,
                loc: self.loc(source_node),
            }];
            body.extend(tail);
            return Ok(body);
        }

        match value.ty() {
            Type::Record { shape_id } => {
                let ty = Type::Record { shape_id };
                let record = &self.records[shape_id];
                if record.tuple
                    || self.callables.contains_key(&shape_id)
                    || self.enum_shape(shape_id)
                    || self.is_data_view(&ty)
                {
                    return Err(self.refuse(
                        source_node,
                        "dictionary spread source needs a plain native object",
                    ));
                }
            }
            Type::Dyn => {}
            _ => {
                return Err(self.refuse(
                    source_node,
                    "dictionary spread source needs native object storage",
                ));
            }
        }

        // Preserve JavaScript own-key semantics for indexed, closed and mixed
        // record layouts. The Dyn value is still the native Rust value ABI;
        // it carries no JavaScript engine and lets objKeys retain true absence
        // of optional fields instead of manufacturing an own `undefined`.
        let source = self.construction_local(Type::Dyn, false);
        let keys = self.construction_local(Type::Dyn, false);
        let index = self.construction_local(Type::F64, true);
        let key = self.construction_local(Type::String, false);
        let erased = self.construction_dynamic_owner(value, source_node)?;
        let source_read = self.construction_read(&source, property);
        let mut stmts = vec![
            Stmt::VarDecl {
                local_id: source.id.clone(),
                init: erased,
                loc: self.loc(property),
            },
            Stmt::VarDecl {
                local_id: keys.id.clone(),
                init: Expr::LibCall {
                    r#fn: "dyn.objKeys".into(),
                    args: vec![source_read.clone()],
                    r#type: Type::Dyn,
                    loc: self.loc(property),
                },
                loc: self.loc(property),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: Expr::NumLit {
                    value: 0.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(property),
                },
                loc: self.loc(property),
            },
        ];
        let keys_read = self.construction_read(&keys, property);
        let index_read = self.construction_read(&index, property);
        let length = self.dynamic_get(
            property,
            keys_read.clone(),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: self.loc(property),
            },
        );
        let length = self.coerce(length, Type::F64, property)?;
        let key_value = self.dynamic_get(
            property,
            keys_read,
            Expr::ToString {
                operand: Box::new(index_read.clone()),
                r#type: Type::String,
                loc: self.loc(property),
            },
        );
        let key_value = self.coerce(key_value, Type::String, property)?;
        let key_read = self.construction_read(&key, property);
        let dynamic_value = self.dynamic_get(property, source_read, key_read.clone());
        let dynamic_value = self.coerce(dynamic_value, target_value.clone(), source_node)?;
        stmts.push(Stmt::While {
            cond: Expr::Bin {
                op: "<".into(),
                left: Box::new(index_read.clone()),
                right: Box::new(length),
                r#type: Type::Bool,
                loc: self.loc(property),
            },
            body: vec![
                Stmt::VarDecl {
                    local_id: key.id.clone(),
                    init: key_value,
                    loc: self.loc(property),
                },
                Stmt::RecordKeySet {
                    obj: self.construction_read(output, property),
                    shape_id: format!("r{target_shape}"),
                    key: key_read,
                    value: dynamic_value,
                    overflow_only: true,
                    loc: self.loc(property),
                },
                Stmt::Assign {
                    local_id: index.id.clone(),
                    value: Expr::Bin {
                        op: "+".into(),
                        left: Box::new(index_read),
                        right: Box::new(Expr::NumLit {
                            value: 1.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(property),
                        }),
                        r#type: Type::F64,
                        loc: self.loc(property),
                    },
                    initializes_global: false,
                    loc: self.loc(property),
                },
            ],
            loc: self.loc(property),
        });
        Ok(stmts)
    }

    pub(super) fn construction_local(&mut self, ty: Type, mutable: bool) -> Local {
        let local = Local {
            id: format!("construct{}", self.locals.len()),
            name: "record construction".into(),
            r#type: ty,
            mutable,
            boxed: false,
        };
        self.locals.push(local.clone());
        local
    }
    pub(super) fn construction_read(&self, local: &Local, node: Node) -> Expr {
        Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        }
    }
    fn construction_undefined(&self, node: Node) -> Expr {
        Expr::UnitLit {
            unit: "undefined",
            r#type: Type::Undefined,
            loc: self.loc(node),
        }
    }
    fn construction_optional(&self, ty: &Type) -> bool {
        // Dyn is the owning ABI for `any`/`unknown`, including undefined.
        // Required-property legality is enforced by the checked frontend; at
        // construction time the question is whether a missing branch has a
        // representation. `record.fromOwn` still preserves actual absence.
        matches!(ty, Type::Dyn | Type::Undefined)
            || matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
    }
    pub(super) fn construct_record(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
    ) -> Result<Expr, String> {
        self.construct_record_from(node, target, properties, None)
    }

    pub(super) fn construct_record_from(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
        source: Option<(Node, Expr)>,
    ) -> Result<Expr, String> {
        self.construct_record_plan(node, target, properties, source, Vec::new())
    }

    pub(super) fn construct_record_assign(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
        source: Node,
    ) -> Result<Expr, String> {
        self.construct_record_assign_many(node, target, properties, vec![source])
    }

    pub(super) fn construct_record_assign_many(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
        sources: Vec<Node>,
    ) -> Result<Expr, String> {
        self.construct_record_plan(node, target, properties, None, sources)
    }

    fn construct_record_plan(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
        source: Option<(Node, Expr)>,
        assign_sources: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            unreachable!()
        };
        let record = self.records[shape_id].clone();
        if record.tuple
            || record.index_value.is_some()
            || self.callables.contains_key(&shape_id)
            || self.enum_shape(shape_id)
        {
            return Err(self.refuse(
                node,
                "record construction needs a closed native data layout",
            ));
        }
        let own = self.construction_local(Type::Dyn, false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: own.id.clone(),
            init: Expr::DynObjLit {
                fields: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        let mut slots = Vec::new();
        for field in record.fields {
            let value = self.construction_local(Type::Dyn, true);
            stmts.push(Stmt::VarDecl {
                local_id: value.id.clone(),
                init: self.coerce(self.construction_undefined(node), Type::Dyn, node)?,
                loc: self.loc(node),
            });
            slots.push(Slot {
                name: field.name,
                ty: field.r#type,
                value,
                inputs: vec![self.construction_undefined(node)],
            });
        }
        let mut plan = Plan {
            slots,
            own,
            assign: !assign_sources.is_empty(),
            dynamic: false,
        };
        let mut definite = HashSet::new();
        if let Some((source, value)) = source {
            let (body, written) = self.construction_copy_value(source, &mut plan, value)?;
            stmts.extend(body);
            definite.extend(written);
        }
        for property in properties {
            let (body, written) = self.construction_property(property, &mut plan)?;
            stmts.extend(body);
            definite.extend(written);
        }
        // The target literal has been evaluated, but the Object.assign call
        // does not copy any source until every argument has been evaluated.
        let mut evaluated_sources = Vec::new();
        for source in assign_sources {
            let value = self.expression(source)?;
            let value = self.update_temp(value, &mut stmts, source);
            evaluated_sources.push((source, value));
        }
        for (source, value) in evaluated_sources {
            let (body, written) = self.construction_copy_value(source, &mut plan, value)?;
            stmts.extend(body);
            definite.extend(written);
        }
        let has_unproven_required = plan
            .slots
            .iter()
            .any(|slot| !self.construction_optional(&slot.ty) && !definite.contains(&slot.name));
        if plan.dynamic && has_unproven_required {
            // A dynamic spread owns its complete runtime key set even when the
            // checker cannot enumerate it into the closed target shape. Keep
            // that object intact and install a shared checked record view;
            // typed field reads validate their payload at the use boundary.
            let result = self.coerce(
                self.construction_read(&plan.own, node),
                target.clone(),
                node,
            )?;
            return Ok(Expr::Sequence {
                stmts,
                result: Box::new(result),
                r#type: target,
                loc: self.loc(node),
            });
        }
        for slot in &plan.slots {
            if !self.construction_optional(&slot.ty) && !definite.contains(&slot.name) {
                return Err(self.refuse(
                    node,
                    &format!(
                        "record construction cannot prove required own field {:?} ({}) on every path; candidate inputs: {:?}",
                        slot.name,
                        self.contextual_type_description(&slot.ty),
                        slot.inputs
                            .iter()
                            .map(|input| self.contextual_type_description(&input.ty()))
                            .collect::<Vec<_>>()
                    ),
                ));
            }
            // Only values that can survive as the last write must fit the
            // published layout. This is a static proof; these expressions
            // are never emitted or evaluated again.
            for input in &slot.inputs {
                let input = if input.ty() == Type::Void {
                    self.construction_undefined(node)
                } else {
                    input.clone()
                };
                self.coerce(input, slot.ty.clone(), node)?;
            }
        }
        let fields = plan
            .slots
            .iter()
            .map(|slot| {
                Ok(ir::FieldInit {
                    name: slot.name.clone(),
                    value: self.coerce(
                        self.construction_read(&slot.value, node),
                        slot.ty.clone(),
                        node,
                    )?,
                    absent: false,
                    overflow: false,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: "record.fromOwn".into(),
                args: vec![
                    Expr::RecordLit {
                        fields,
                        null_prototype: false,
                        r#type: target.clone(),
                        loc: self.loc(node),
                    },
                    self.construction_read(&plan.own, node),
                ],
                r#type: target.clone(),
                loc: self.loc(node),
            }),
            r#type: target,
            loc: self.loc(node),
        })
    }
    fn construction_write(
        &self,
        node: Node,
        plan: &mut Plan,
        slot_index: usize,
        value: Expr,
    ) -> Result<Vec<Stmt>, String> {
        let slot = &plan.slots[slot_index];
        // Intermediate writes can have a different representation from the
        // published field. Retain their actual value until all overrides run;
        // only the final materialization checks the target layout.
        // A proven invariant record view changes no value or property and
        // retains the tag needed when that view is boxed into the final slot.
        let value =
            if ir::record_views::view_pairs(&value.ty(), &slot.ty, &self.records, &self.unions)
                .is_some()
            {
                self.coerce(value, slot.ty.clone(), node)?
            } else {
                value
            };
        let local = slot.value.clone();
        let name = slot.name.clone();
        let slot_type = slot.ty.clone();
        plan.slots[slot_index].inputs = vec![value.clone()];
        let erased = if self.namespace_capsule(&value.ty()) && value.ty() == slot_type {
            // The record's typed field remains the namespace capsule and all
            // namespace member reads still resolve through live bindings. Its
            // shared own-property store only needs an identity-preserving box
            // so the field participates in ordinary object spread/reflection;
            // this does not grant arbitrary erased namespace dispatch.
            Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
        } else {
            self.construction_own_value(value, node)?
        };
        Ok(vec![
            Stmt::Assign {
                local_id: local.id.clone(),
                value: erased,
                initializes_global: false,
                loc: self.loc(node),
            },
            self.construction_set_own(
                node,
                plan,
                Expr::StrLit {
                    value: name,
                    r#type: Type::String,
                    loc: self.loc(node),
                },
                self.construction_read(&local, node),
            ),
        ])
    }
    fn construction_set_own(&self, node: Node, plan: &Plan, key: Expr, value: Expr) -> Stmt {
        Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "record.setOwn".into(),
                args: vec![self.construction_read(&plan.own, node), key, value],
                r#type: Type::Void,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }
    }
    fn construction_property(
        &mut self,
        property: Node,
        plan: &mut Plan,
    ) -> Result<(Vec<Stmt>, HashSet<String>), String> {
        if property.kind() == SyntaxKind::SpreadAssignment {
            return self.construction_source(property.expression(), plan);
        }
        if !matches!(
            property.kind(),
            SyntaxKind::PropertyAssignment
                | SyntaxKind::ShorthandPropertyAssignment
                | SyntaxKind::MethodDeclaration
        ) {
            return Err(self.refuse(
                property,
                "record construction requires named data properties",
            ));
        }
        let name = self
            .data_property_name(property.name())
            .ok_or_else(|| self.refuse(property, "computed construction keys are not ported"))?;
        if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
            return Err(self.refuse(property, "object prototype setters are not ported"));
        }
        let slot_index = plan
            .slots
            .iter()
            .position(|s| s.name == name)
            .ok_or_else(|| {
                let fields = plan
                    .slots
                    .iter()
                    .map(|slot| slot.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                self.refuse(
                    property,
                    &format!(
                        "record construction width projection is not ported: target owns [{fields}] but the literal also defines {name:?}"
                    ),
                )
            })?;
        let slot_type = plan.slots[slot_index].ty.clone();
        let source = match property.kind() {
            SyntaxKind::MethodDeclaration => property,
            SyntaxKind::ShorthandPropertyAssignment => property.name(),
            _ => property.initializer(),
        };
        // Context still supplies callable ABIs and aggregate element layouts
        // when the source is assignable to it. An overwritten incompatible
        // value must instead keep its own representation.
        let context = self.checker.get_contextual_type(source, ContextFlags::NONE);
        let source_type = self.checker.get_type_at_location(source);
        let context = if source.kind() == SyntaxKind::ArrayLiteralExpression
            && matches!(slot_type, Type::Array { .. })
        {
            // The checker represents a contextually typed empty literal as
            // never[]/any[] in several spread-construction paths. The final
            // record slot is the authoritative native container ABI; lower
            // every literal element against it (zero elements is vacuously
            // valid) instead of publishing Array<Dyn> storage.
            Some(slot_type)
        } else if context.0 != 0 && self.checker.is_type_assignable_to(source_type, context) {
            self.type_id(context)
        } else {
            None
        };
        let value = if let Some(context) = context {
            self.object_property_value(property, context)?
        } else if property.kind() == SyntaxKind::MethodDeclaration {
            let ty = self.ty(source)?;
            self.object_property_value(property, ty)?
        } else {
            self.expression(source)?
        };
        Ok((
            self.construction_write(property, plan, slot_index, value)?,
            HashSet::from([name]),
        ))
    }
    fn construction_source(
        &mut self,
        source: Node,
        plan: &mut Plan,
    ) -> Result<(Vec<Stmt>, HashSet<String>), String> {
        match source.kind() {
            SyntaxKind::ParenthesizedExpression => {
                self.construction_source(source.expression(), plan)
            }
            SyntaxKind::ObjectLiteralExpression => {
                let mut body = Vec::new();
                let mut definite = HashSet::new();
                for property in source.properties() {
                    let (next, written) = self.construction_property(property, plan)?;
                    body.extend(next);
                    definite.extend(written);
                }
                Ok((body, definite))
            }
            SyntaxKind::ConditionalExpression => {
                let value = self.condition_value(source.condition())?;
                let cond = self.condition(value, source.condition())?;
                let before = self.var_defined.clone();
                if let Some(symbol) = self.guarded_var(source.condition(), true) {
                    self.var_defined.insert(symbol);
                }
                let before_inputs = plan
                    .slots
                    .iter()
                    .map(|s| s.inputs.clone())
                    .collect::<Vec<_>>();
                let (then, yes) = self.construction_source(source.when_true(), plan)?;
                let then_inputs = plan
                    .slots
                    .iter()
                    .map(|s| s.inputs.clone())
                    .collect::<Vec<_>>();
                for (slot, inputs) in plan.slots.iter_mut().zip(before_inputs) {
                    slot.inputs = inputs;
                }
                let then_defined = self.var_defined.clone();
                self.var_defined = before;
                if let Some(symbol) = self.guarded_var(source.condition(), false) {
                    self.var_defined.insert(symbol);
                }
                let (other, no) = self.construction_source(source.when_false(), plan)?;
                for (slot, inputs) in plan.slots.iter_mut().zip(then_inputs) {
                    for input in inputs {
                        if !slot.inputs.iter().any(|old| old.ty() == input.ty()) {
                            slot.inputs.push(input);
                        }
                    }
                }
                self.var_defined = then_defined
                    .intersection(&self.var_defined)
                    .copied()
                    .collect();
                Ok((
                    vec![Stmt::If {
                        cond,
                        then,
                        else_: Some(other),
                        loc: self.loc(source),
                    }],
                    yes.intersection(&no).cloned().collect(),
                ))
            }
            _ => self.construction_copy(source, plan),
        }
    }
    fn construction_copy(
        &mut self,
        source: Node,
        plan: &mut Plan,
    ) -> Result<(Vec<Stmt>, HashSet<String>), String> {
        let value = self.expression(source)?;
        self.construction_copy_value(source, plan, value)
    }
    fn construction_copy_value(
        &mut self,
        source: Node,
        plan: &mut Plan,
        value: Expr,
    ) -> Result<(Vec<Stmt>, HashSet<String>), String> {
        // Object spread treats null and undefined as empty sources.  The
        // expression has already been evaluated, so there is no remaining
        // effect or own property to copy.
        if matches!(value.ty(), Type::Null | Type::Undefined) {
            return Ok((Vec::new(), HashSet::new()));
        }
        if self.namespace_capsule(&value.ty()) {
            // Module namespaces are identity capsules whose properties remain
            // live bindings. Object spread snapshots their enumerable string
            // exports at this source position. Resolve only fields represented
            // by the destination construction plan; later spreads and explicit
            // properties still overwrite them in normal JavaScript order.
            let owner = self.construction_local(value.ty(), false);
            let mut body = vec![Stmt::VarDecl {
                local_id: owner.id,
                init: value,
                loc: self.loc(source),
            }];
            let names = plan
                .slots
                .iter()
                .map(|slot| slot.name.clone())
                .collect::<Vec<_>>();
            let mut definite = HashSet::new();
            for (index, name) in names.into_iter().enumerate() {
                let Some(export) = self.namespace_export_value(source, &name, source)? else {
                    continue;
                };
                body.extend(self.construction_write(source, plan, index, export)?);
                definite.insert(name);
            }
            return Ok((body, definite));
        }
        if let Type::Union { union_id } = value.ty() {
            let arms = self.unions[union_id].arms.clone();
            if arms.is_empty()
                || arms.iter().any(|arm| {
                    !matches!(
                        arm,
                        Type::Record { .. }
                            | Type::String
                            | Type::F64
                            | Type::Bool
                            | Type::Bigint
                            | Type::Symbol
                            | Type::Dyn
                            | Type::Null
                            | Type::Undefined
                    )
                })
            {
                return Err(self.refuse(
                    source,
                    &format!(
                        "spread source union requires closed native data record or nullish arms: {:?}",
                        arms
                    ),
                ));
            }
            let local = self.construction_local(value.ty(), false);
            let before_defined = self.var_defined.clone();
            let before_inputs = plan
                .slots
                .iter()
                .map(|slot| slot.inputs.clone())
                .collect::<Vec<_>>();
            let mut branches = Vec::new();
            let mut branch_inputs = Vec::new();
            let mut after_defined: Option<HashSet<u32>> = None;
            let mut definite: Option<HashSet<String>> = None;
            for (tag, arm) in arms.into_iter().enumerate() {
                for (slot, inputs) in plan.slots.iter_mut().zip(&before_inputs) {
                    slot.inputs = inputs.clone();
                }
                self.var_defined = before_defined.clone();
                let mut narrowed = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(self.construction_read(&local, source)),
                    r#type: arm.clone(),
                    loc: self.loc(source),
                };
                if matches!(
                    arm,
                    Type::String | Type::F64 | Type::Bool | Type::Bigint | Type::Symbol | Type::Dyn
                ) {
                    // Object spread applies ToObject to primitive arms. The
                    // dynamic own-key path already models string indices and
                    // the empty enumerable surface of the other primitives.
                    narrowed = self.coerce(narrowed, Type::Dyn, source)?;
                }
                let (body, fields) = self.construction_copy_value(source, plan, narrowed)?;
                branch_inputs.push(
                    plan.slots
                        .iter()
                        .map(|slot| slot.inputs.clone())
                        .collect::<Vec<_>>(),
                );
                after_defined = Some(match after_defined {
                    Some(previous) => previous.intersection(&self.var_defined).copied().collect(),
                    None => self.var_defined.clone(),
                });
                definite = Some(match definite {
                    Some(previous) => previous.intersection(&fields).cloned().collect(),
                    None => fields,
                });
                branches.push(body);
            }
            let definite = definite.unwrap_or_default();
            if plan
                .slots
                .iter()
                .any(|slot| !self.construction_optional(&slot.ty) && !definite.contains(&slot.name))
            {
                // A non-null assertion or checker narrowing can leave the
                // owning IR value as record | undefined even though the
                // contextual object literal requires fields from the record
                // arm. Preserve the actual own-key copy and attach a checked
                // view after the branch instead of materializing an absent
                // field as undefined.
                plan.dynamic = true;
            }
            for (index, slot) in plan.slots.iter_mut().enumerate() {
                slot.inputs = if definite.contains(&slot.name) {
                    Vec::new()
                } else {
                    before_inputs[index].clone()
                };
                for inputs in &branch_inputs {
                    for input in &inputs[index] {
                        if !slot.inputs.iter().any(|old| old.ty() == input.ty()) {
                            slot.inputs.push(input.clone());
                        }
                    }
                }
            }
            self.var_defined = after_defined.unwrap_or(before_defined);
            let mut tail = branches.pop().expect("non-empty union spread");
            while let Some(body) = branches.pop() {
                let tag = branches.len();
                tail = vec![Stmt::If {
                    cond: Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        value: Box::new(self.construction_read(&local, source)),
                        r#type: Type::Bool,
                        loc: self.loc(source),
                    },
                    then: body,
                    else_: Some(tail),
                    loc: self.loc(source),
                }];
            }
            let mut body = vec![Stmt::VarDecl {
                local_id: local.id,
                init: value,
                loc: self.loc(source),
            }];
            body.extend(tail);
            return Ok((body, definite));
        }
        let record = match value.ty() {
            Type::Record { shape_id } => {
                if self.is_data_view(&Type::Record { shape_id }) {
                    return Err(self.refuse(source, "DataView own-key projection is not ported"));
                }
                let record = self.records[shape_id].clone();
                if record.tuple
                    || self.callables.contains_key(&shape_id)
                    || self.enum_shape(shape_id)
                {
                    return Err(self.refuse(
                        source,
                        "spread source needs a closed data record without receiver semantics",
                    ));
                }
                Some((shape_id, record))
            }
            Type::Dyn => None,
            _ => {
                return Err(
                    self.refuse(source, "spread source needs a native object representation")
                );
            }
        };
        let hidden_required = record.as_ref().is_some_and(|(_, record)| {
            plan.slots.iter().any(|slot| {
                !self.construction_optional(&slot.ty)
                    && record
                        .fields
                        .iter()
                        .find(|field| field.name == slot.name)
                        .is_none_or(|field| self.construction_optional(&field.r#type))
            })
        });
        if hidden_required
            || record
                .as_ref()
                .is_none_or(|(_, record)| record.index_value.is_some())
        {
            // Index-signature records still expose their named fields through
            // the typed layout, while arbitrary enumerable keys travel through
            // the shared dynamic backing store. A narrower closed view can
            // likewise hide a required own key that TypeScript proved through
            // the contextual source type. The runtime own-key copy retains it;
            // final typed reads remain checked through the shared record view.
            plan.dynamic = true;
        }
        let object = self.construction_local(value.ty(), false);
        let keys = self.construction_local(Type::Dyn, false);
        let index = self.construction_local(Type::F64, true);
        let key = self.construction_local(Type::String, true);
        let mut body = vec![
            Stmt::VarDecl {
                local_id: object.id.clone(),
                init: value,
                loc: self.loc(source),
            },
            Stmt::VarDecl {
                local_id: keys.id.clone(),
                init: Expr::LibCall {
                    r#fn: "dyn.objKeys".into(),
                    args: vec![self.construction_dynamic_owner(
                        self.construction_read(&object, source),
                        source,
                    )?],
                    r#type: Type::Dyn,
                    loc: self.loc(source),
                },
                loc: self.loc(source),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: Expr::NumLit {
                    value: 0.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(source),
                },
                loc: self.loc(source),
            },
            Stmt::VarDecl {
                local_id: key.id.clone(),
                init: Expr::StrLit {
                    value: String::new(),
                    r#type: Type::String,
                    loc: self.loc(source),
                },
                loc: self.loc(source),
            },
        ];
        let key_value = self.dynamic_get(
            source,
            self.construction_read(&keys, source),
            Expr::ToString {
                operand: Box::new(self.construction_read(&index, source)),
                r#type: Type::String,
                loc: self.loc(source),
            },
        );
        let mut iteration = vec![Stmt::Assign {
            local_id: key.id.clone(),
            value: self.coerce(key_value, Type::String, source)?,
            initializes_global: false,
            loc: self.loc(source),
        }];
        // Preserve every own entry, including fields hidden by a narrower
        // static view. Known target slots are also checked below for the typed
        // initialization proof; unknown entries never disappear in a spread.
        let dynamic_object =
            self.construction_dynamic_owner(self.construction_read(&object, source), source)?;
        let mut raw =
            self.dynamic_get(source, dynamic_object, self.construction_read(&key, source));
        if record.is_none() {
            let property = self.construction_local(Type::Dyn, false);
            iteration.push(Stmt::VarDecl {
                local_id: property.id.clone(),
                init: raw,
                loc: self.loc(source),
            });
            raw = self.construction_read(&property, source);
        }
        if plan.assign {
            iteration.push(self.checked_dynamic_property_set(
                source,
                self.construction_read(&plan.own, source),
                self.construction_read(&key, source),
                raw.clone(),
            )?);
        } else {
            iteration.push(self.construction_set_own(
                source,
                plan,
                self.construction_read(&key, source),
                raw.clone(),
            ));
        }
        let mut definite = HashSet::new();
        let projected = if let Some((shape_id, record)) = &record {
            record
                .fields
                .iter()
                .map(|field| {
                    (
                        field.name.clone(),
                        field.r#type.clone(),
                        Expr::RecordGet {
                            obj: Box::new(self.construction_read(&object, source)),
                            shape_id: format!("r{shape_id}"),
                            field: field.name.clone(),
                            r#type: field.r#type.clone(),
                            loc: self.loc(source),
                        },
                        !self.construction_optional(&field.r#type),
                    )
                })
                .collect::<Vec<_>>()
        } else {
            plan.slots
                .iter()
                .map(|slot| (slot.name.clone(), Type::Dyn, raw.clone(), false))
                .collect::<Vec<_>>()
        };
        for (field_name, field_type, value, required) in projected {
            let Some(slot_index) = plan.slots.iter().position(|s| s.name == field_name) else {
                continue;
            };
            let previous = plan.slots[slot_index].inputs.clone();
            let writes = self.construction_write(source, plan, slot_index, value)?;
            if !required {
                for input in previous {
                    if !plan.slots[slot_index]
                        .inputs
                        .iter()
                        .any(|old| old.ty() == input.ty())
                    {
                        plan.slots[slot_index].inputs.push(input);
                    }
                }
            }
            let cond = Expr::StrEq {
                left: Box::new(self.construction_read(&key, source)),
                right: Box::new(Expr::StrLit {
                    value: field_name.clone(),
                    r#type: Type::String,
                    loc: self.loc(source),
                }),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(source),
            };
            iteration.push(Stmt::If {
                cond,
                then: writes,
                else_: None,
                loc: self.loc(source),
            });
            if required && !self.construction_optional(&field_type) {
                definite.insert(field_name);
            }
        }
        iteration.push(Stmt::Assign {
            local_id: index.id.clone(),
            value: Expr::Bin {
                op: "+".into(),
                left: Box::new(self.construction_read(&index, source)),
                right: Box::new(Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(source),
                }),
                r#type: Type::F64,
                loc: self.loc(source),
            },
            initializes_global: false,
            loc: self.loc(source),
        });
        let length = self.dynamic_get(
            source,
            self.construction_read(&keys, source),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: self.loc(source),
            },
        );
        body.push(Stmt::While {
            cond: Expr::Bin {
                op: "<".into(),
                left: Box::new(self.construction_read(&index, source)),
                right: Box::new(self.coerce(length, Type::F64, source)?),
                r#type: Type::Bool,
                loc: self.loc(source),
            },
            body: iteration,
            loc: self.loc(source),
        });
        body.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.copyEnumerableSymbols".into(),
                args: vec![
                    self.construction_read(&plan.own, source),
                    self.construction_dynamic_owner(
                        self.construction_read(&object, source),
                        source,
                    )?,
                ],
                r#type: Type::Void,
                loc: self.loc(source),
            },
            loc: self.loc(source),
        });
        Ok((body, definite))
    }
}
