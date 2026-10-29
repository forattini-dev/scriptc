//! Closed structural records, function-valued fields and tagged native unions.
use super::*;
use source_frontend::prelude::{ObjectFlags, SignatureKind};

impl Lowerer<'_> {
    pub(super) fn aggregate_type(&mut self, id: TypeId) -> Option<Type> {
        let flags = self.checker.ty(id).flags;
        if flags.intersects(TypeFlags::NULL) {
            return Some(Type::Null);
        }
        if flags.intersects(TypeFlags::UNDEFINED) {
            return Some(Type::Undefined);
        }
        if let Some(cached) = self.types.get(&id) {
            return match cached {
                type_graph::Resolution::Ready(ty) => Some(ty.clone()),
                type_graph::Resolution::Failed { .. } => None,
                type_graph::Resolution::Resolving { .. } => self.recursive_layout(id),
            };
        }
        let checkpoint = self
            .type_stack
            .is_empty()
            .then(|| type_graph::Checkpoint::new(self));
        self.type_stack.push(id);
        self.types.insert(
            id,
            type_graph::Resolution::Resolving {
                kind: type_graph::LayoutKind::Other,
                reference: None,
            },
        );
        let mut result = self.aggregate_type_inner(id);
        let reference = self.reserved_layout(id);
        self.types.insert(
            id,
            match &result {
                Some(ty) => type_graph::Resolution::Ready(ty.clone()),
                None => type_graph::Resolution::Failed { reference },
            },
        );
        assert_eq!(self.type_stack.pop(), Some(id));
        if let Some(checkpoint) = checkpoint {
            if checkpoint.failed_layout(self) {
                result = None;
            }
            if result.is_none() {
                checkpoint.restore(self);
                self.types
                    .insert(id, type_graph::Resolution::Failed { reference: None });
            }
        }
        result
    }

    fn aggregate_type_inner(&mut self, id: TypeId) -> Option<Type> {
        let flags = self.checker.ty(id).flags;
        if flags.intersects(TypeFlags::INTERSECTION)
            && self
                .checker
                .ty(id)
                .types()
                .iter()
                .any(|part| self.checker.is_tuple_type(*part))
        {
            return self.tuple_intersection_type(id);
        }
        if self.checker.is_tuple_type(id) {
            return self.tuple_type(id);
        }
        if self.checker.is_array_type(id) {
            let element = self.checker.get_element_type_of_array_type(id);
            let elem = self.aggregate_slot_type(element)?;
            if matches!(
                elem,
                Type::Void | Type::Null | Type::Undefined | Type::Func { .. } | Type::Stats
            ) || matches!(&elem, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Stats)) {
                return None;
            }
            return Some(Type::Array {
                elem: Box::new(elem),
            });
        }
        if let Some(ty) = self.promise_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.map_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.set_type(id) {
            return Some(ty);
        }
        if flags.intersects(TypeFlags::OBJECT | TypeFlags::INTERSECTION)
            && !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CALL)
                .is_empty()
        {
            return self.callable_type(id);
        }
        if flags.intersects(TypeFlags::UNION) {
            self.resolving_layout(id, type_graph::LayoutKind::Union);
            let source = self.checker.ty(id).types().to_vec();
            let mut arms = Vec::new();
            for source in source {
                let arm = self.type_id(source)?;
                if let Type::Union { union_id } = arm {
                    if self.unions[union_id].arms.is_empty() {
                        return None;
                    }
                    arms.extend(self.unions[union_id].arms.clone());
                } else {
                    arms.push(arm);
                }
            }
            if let Some(Type::Union { union_id }) = self.reserved_layout(id) {
                let arms = self.union_arms(arms)?;
                if arms.len() < 2 || arms.contains(&Type::Dyn) {
                    return None;
                }
                self.unions[union_id].arms = arms;
                return Some(Type::Union { union_id });
            }
            return self.intern_union(arms);
        }
        if !flags.intersects(TypeFlags::OBJECT | TypeFlags::INTERSECTION)
            || self
                .checker
                .ty(id)
                .object_flags()
                .intersects(ObjectFlags::CLASS)
            // Instantiated generic classes carry REFERENCE rather than CLASS
            // object flags. They still have nominal instance storage; a checked
            // declaration snapshot must never project them into a plain record.
            || (self.checker.ty(id).symbol().0 != 0
                && self.checker.sym(self.checker.ty(id).symbol()).flags.intersects(SymbolFlags::CLASS))
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CALL)
                .is_empty()
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CONSTRUCT)
                .is_empty()
        {
            return None;
        }
        self.resolving_layout(id, type_graph::LayoutKind::Record);
        let properties = self.checker.get_properties_of_type(id).to_vec();
        let indexes = self.checker.get_index_infos_of_type(id).to_vec();
        let index_value = if indexes.is_empty() {
            None
        } else {
            // Mixed declared/indexed shapes and other key domains need
            // separate projection/prototype handling; don't erase their fields.
            if indexes.len() != 1 || !properties.is_empty() {
                return None;
            }
            let index = self.checker.index_info(indexes[0]);
            if !self
                .checker
                .ty(index.key_type)
                .flags
                .intersects(TypeFlags::STRING | TypeFlags::NUMBER)
            {
                return None;
            }
            let source = index.value_type;
            let ty = self.type_id(source)?;
            if matches!(
                ty,
                Type::Null
                    | Type::Undefined
                    | Type::Void
                    | Type::Func { .. }
                    | Type::Map { .. }
                    | Type::Stats
            ) || matches!(&ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Stats)) {
                return None;
            }
            Some(ty)
        };
        let mut fields = Vec::new();
        for property in properties {
            let name = self.checker.sym(property).name.to_string();
            // Accessors need descriptor storage. Ordinary object methods use
            // owning function fields and the existing call-site receiver ABI.
            if self
                .checker
                .sym(property)
                .flags
                .intersects(SymbolFlags::ACCESSOR)
            {
                return None;
            }
            let source = self.checker.get_type_of_symbol(property);
            let mut ty = self.aggregate_slot_type(source)?;
            if self
                .checker
                .sym(property)
                .flags
                .intersects(SymbolFlags::OPTIONAL)
                || (self.js_absent_fields.contains(&(id, name.clone()))
                    && matches!(ty, Type::String | Type::F64 | Type::Bool))
            {
                if matches!(ty, Type::Union { union_id } if self.unions[union_id].arms.is_empty()) {
                    // A recursive union is reserved before its arms exist.
                    // Copying the empty arm list would collapse this field to
                    // undefined. Retain the reference when its source union
                    // already owns absence; otherwise refuse this layout query.
                    if !self.checker.ty(source).flags.intersects(TypeFlags::UNION)
                        || !self
                            .checker
                            .ty(source)
                            .types()
                            .iter()
                            .any(|arm| self.checker.ty(*arm).flags.intersects(TypeFlags::UNDEFINED))
                    {
                        return None;
                    }
                } else {
                    let mut arms = match ty {
                        Type::Union { union_id } => self.unions[union_id].arms.clone(),
                        _ => vec![ty],
                    };
                    arms.push(Type::Undefined);
                    ty = self.intern_union(arms)?;
                }
            }
            fields.push(ir::Field { name, r#type: ty });
        }
        let declared_order = fields.iter().map(|f| f.name.clone()).collect();
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(Type::Record { shape_id }) = self.reserved_layout(id) {
            self.records[shape_id] = ir::Record {
                id: shape_id,
                fields,
                declared_order,
                tuple: false,
                index_value,
            };
            return Some(Type::Record { shape_id });
        }
        if let Some(record) = self.records.iter().find(|r| {
            !r.tuple
                && !self.pending_layout(&Type::Record { shape_id: r.id })
                && !self.enum_shape(r.id)
                && !self.is_data_view(&Type::Record { shape_id: r.id })
                && !self.callables.contains_key(&r.id)
                && r.fields == fields
                && r.index_value == index_value
        }) {
            return Some(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order,
            tuple: false,
            index_value,
        });
        Some(Type::Record { shape_id })
    }

    fn union_arms(&self, mut arms: Vec<Type>) -> Option<Vec<Type>> {
        if arms.contains(&Type::Dyn) {
            return Some(vec![Type::Dyn]);
        }
        arms.sort_by_key(|a| format!("{a:?}"));
        arms.dedup();
        if arms.len() == 1 {
            return Some(arms);
        }
        if arms.is_empty()
            || (arms.iter().any(|a| matches!(a, Type::Set { .. }))
                && (arms.iter().filter(|a| matches!(a, Type::Set { .. })).count() != 1
                    || arms.iter().any(|a| !matches!(a, Type::Set { .. } | Type::Null | Type::Undefined))))
            // Different static Error views can alias the same object. Keep a
            // single object arm until cross-arm identity is part of the IR ABI.
            || arms.iter().filter(|a| matches!(a, Type::Object { .. })).count() > 1
            || (arms.contains(&Type::Stats)
                && arms.iter().any(|a| !matches!(a, Type::Stats | Type::Null | Type::Undefined)))
            || arms
                .iter()
                .any(|a| matches!(a, Type::Void | Type::Map { .. }))
        {
            return None;
        }
        Some(arms)
    }

    pub(super) fn intern_union(&mut self, arms: Vec<Type>) -> Option<Type> {
        let arms = self.union_arms(arms)?;
        if arms.len() == 1 {
            return Some(arms[0].clone());
        }
        if let Some(union) = self.unions.iter().find(|u| u.arms == arms) {
            return Some(Type::Union { union_id: union.id });
        }
        let union_id = self.unions.len();
        self.unions.push(ir::Union { id: union_id, arms });
        Some(Type::Union { union_id })
    }

    pub(super) fn dynamic_erasure_reason(&self, ty: &Type) -> Option<&'static str> {
        if self.native_type_contains(ty, |ty| {
            if let Type::Classval { class_name } = ty {
                self.classes.has_static_methods(class_name)
            } else {
                false
            }
        }) {
            return Some("erasing class static methods requires a native descriptor contract");
        }
        if self.native_type_contains(
            ty,
            |ty| matches!(ty, Type::Bytes { elem } if matches!(elem.as_str(), "i32" | "u32")),
        ) {
            return Some(
                "32-bit integer typed array erasure requires a shared native value contract",
            );
        }
        if self.native_type_contains(ty, |ty| self.is_data_view(ty)) {
            return Some("DataView erasure requires a native DataView brand contract");
        }
        if ir::contains_stats(ty, &self.records, &self.unions) {
            return Some("Stats erasure requires a shared native Stats value contract");
        }
        if self.native_type_contains(ty, |ty| matches!(ty, Type::Object { class_name } if self.classes.has_symbol_surface(class_name))) {
            return Some("erasing symbol methods requires a native descriptor contract");
        }
        if self.native_type_contains(ty, weak_maps::instance) {
            return Some("erasing WeakMap requires a native property descriptor contract");
        }
        if self.native_type_contains(ty, classes::weak_sets::instance) {
            return Some("erasing WeakSet requires a native property descriptor contract");
        }
        if self.native_type_contains(ty, async_context::instance) {
            return Some(
                "erasing AsyncLocalStorage requires a native property descriptor contract",
            );
        }
        if self.contains_namespace(ty) {
            return Some(
                "erasing module namespaces requires a native namespace descriptor contract",
            );
        }
        if ir::contains_set(ty, &self.records, &self.unions) {
            return Some("erasing Set requires a shared native Set value contract");
        }
        if let Type::Record { shape_id } = ty
            && self.callables.contains_key(shape_id)
        {
            return Some(
                "erasing callable data properties requires a shared native function property view",
            );
        }
        None
    }

    pub(super) fn coerce(&self, value: Expr, target: Type, node: Node) -> Result<Expr, String> {
        if value.ty() == target {
            return Ok(value);
        }
        if self.native_type_contains(&value.ty(), |ty| self.is_data_view(ty))
            || self.native_type_contains(&target, |ty| self.is_data_view(ty))
        {
            return Err(self.refuse(
                node,
                &format!(
                    "DataView conversions require a native DataView brand contract: {:?} -> {:?}",
                    value.ty(),
                    target
                ),
            ));
        }
        // Unit payloads have no stored fields, but their producing expressions
        // can still evaluate conditions, reads and calls. Lift their control
        // flow before boxing a unit or constructing a payload-free union arm.
        let value = if matches!(value.ty(), Type::Null | Type::Undefined)
            && !matches!(value, Expr::UnitLit { .. })
        {
            match value {
                Expr::Ternary {
                    cond,
                    then,
                    else_,
                    loc,
                    ..
                } => {
                    return Ok(Expr::Ternary {
                        cond,
                        then: Box::new(self.coerce(*then, target.clone(), node)?),
                        else_: Box::new(self.coerce(*else_, target.clone(), node)?),
                        r#type: target,
                        loc,
                    });
                }
                Expr::Sequence {
                    stmts, result, loc, ..
                } => {
                    return Ok(Expr::Sequence {
                        stmts,
                        result: Box::new(self.coerce(*result, target.clone(), node)?),
                        r#type: target,
                        loc,
                    });
                }
                value if target != Type::Dyn => {
                    let unit = Expr::UnitLit {
                        unit: if value.ty() == Type::Null {
                            "null"
                        } else {
                            "undefined"
                        },
                        r#type: value.ty(),
                        loc: self.loc(node),
                    };
                    return Ok(Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: self.coerce(value, Type::Dyn, node)?,
                            loc: self.loc(node),
                        }],
                        result: Box::new(self.coerce(unit, target.clone(), node)?),
                        r#type: target,
                        loc: self.loc(node),
                    });
                }
                value => value,
            }
        } else {
            value
        };
        if matches!(value.ty(), Type::Promise { .. }) && matches!(target, Type::Promise { .. }) {
            let value = self.coerce(value, Type::Dyn, node)?;
            return self.coerce(value, target, node);
        }
        if target == Type::Dyn {
            if value.ty() == Type::Void {
                // A call with a void ABI still evaluates in argument position
                // and contributes the JavaScript undefined value.
                let undefined = self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?;
                return Ok(Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node),
                    }],
                    result: Box::new(undefined),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
            if let Some(reason) = self.dynamic_erasure_reason(&value.ty()) {
                return Err(self.refuse(node, reason));
            }
            return Ok(Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        if value.ty() == Type::Dyn && !matches!(target, Type::Null | Type::Undefined | Type::Void) {
            if self.native_type_contains(
                &target,
                |ty| matches!(ty, Type::Bytes { elem } if matches!(elem.as_str(), "i32" | "u32")),
            ) {
                return Err(self.refuse(
                    node,
                    "32-bit integer typed array extraction requires a shared native value contract",
                ));
            }
            if ir::contains_stats(&target, &self.records, &self.unions) {
                return Err(self.refuse(
                    node,
                    "Stats extraction requires a shared native Stats value contract",
                ));
            }
            return Ok(Expr::DynCheck {
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let (
            Type::Union { union_id: source },
            Type::Union {
                union_id: destination,
            },
        ) = (value.ty(), &target)
            && self.unions[source].arms.iter().all(|arm| {
                matches!(
                    arm,
                    Type::F64
                        | Type::Bigint
                        | Type::String
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::Symbol
                ) && self.unions[*destination].arms.contains(arm)
            })
        {
            // Widening a primitive union changes its tag layout, not its
            // value. Retain the active payload through the owning bridge.
            let value = self.coerce(value, Type::Dyn, node)?;
            return self.coerce(value, target, node);
        }
        if let Type::Record { shape_id } = value.ty()
            && self.callables.get(&shape_id) == Some(&target)
        {
            return Ok(Expr::RecordGet {
                obj: Box::new(value),
                shape_id: format!("r{shape_id}"),
                field: callables::CALL_FIELD.into(),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let (Type::Object { class_name: child }, Type::Object { class_name: parent }) =
            (value.ty(), &target)
            && self.classes.subclass(&child, parent)
        {
            return Ok(Expr::Upcast {
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let Type::Union { union_id } = target
            && let Some(tag) = self.unions[union_id]
                .arms
                .iter()
                .position(|a| *a == value.ty())
        {
            return Ok(Expr::UnionWrap {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let Type::Union { union_id } = target
            && let Type::Object { class_name: child } = value.ty()
        {
            let candidates = self.unions[union_id].arms.iter().enumerate().filter(|(_, arm)| matches!(arm, Type::Object { class_name: parent } if self.classes.subclass(&child, parent))).collect::<Vec<_>>();
            if let [(tag, arm)] = candidates.as_slice() {
                let value = self.coerce(value, (*arm).clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if ir::record_views::view_pairs(&value.ty(), &target, &self.records, &self.unions).is_some()
        {
            return Ok(Expr::LibCall {
                r#fn: "record.view".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        let describe = |ty: &Type| {
            if let Type::Union { union_id } = ty
                && let Some(union) = self.unions.get(*union_id)
            {
                let arms = union
                    .arms
                    .iter()
                    .take(8)
                    .map(|arm| format!("{arm:?}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                return format!(
                    "union u{union_id} [{arms}{}]",
                    if union.arms.len() > 8 { ", ..." } else { "" }
                );
            }
            if let Type::Record { shape_id } = ty
                && let Some(shape) = self.records.get(*shape_id)
            {
                let fields = shape
                    .fields
                    .iter()
                    .take(8)
                    .map(|field| format!("{}: {:?}", field.name, field.r#type))
                    .collect::<Vec<_>>()
                    .join(", ");
                return format!(
                    "record r{shape_id} {{{fields}{}}}",
                    if shape.fields.len() > 8 { ", ..." } else { "" }
                );
            }
            format!("{ty:?}")
        };
        Err(self.refuse(
            node,
            &format!(
                "native representation coercion is not ported: {} -> {}",
                describe(&value.ty()),
                describe(&target)
            ),
        ))
    }

    pub(super) fn narrowed(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if let Some(value) = self.guarded_truthy_assignment(node, &value) {
            return Ok(value);
        }
        if value.ty() == Type::Caught {
            let target = self.ty(node)?;
            if target == Type::Symbol {
                // The shared caughtNarrow contract covers numeric/string/Error
                // views. Other primitive payloads use its owning dynamic bridge.
                let value = Expr::CaughtToDyn {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                };
                return self.coerce(value, target, node);
            }
            if matches!(
                target,
                Type::F64 | Type::String | Type::Bool | Type::Object { .. }
            ) {
                return Ok(Expr::CaughtNarrow {
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
            return Ok(Expr::CaughtToDyn {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        // A lowered value already carries a verified native representation.
        // Untyped JS doesn't supply additional control-flow evidence.
        if self.checker_any(node) {
            if let Some(narrowed) = self.guarded_truthy_return(node, &value) {
                return Ok(narrowed);
            }
            return Ok(value);
        }
        if let Type::Object { class_name: parent } = value.ty() {
            let target = self.ty(node)?;
            if let Type::Object { class_name: child } = &target
                && *child != parent
                && self.classes.subclass(child, &parent)
            {
                return Ok(Expr::Downcast {
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
            return Ok(value);
        }
        if value.ty() == Type::Dyn {
            if self.bytes_named_key_value(node, &mut HashSet::new()) {
                return Ok(value);
            }
            let target = self.ty(node)?;
            if matches!(
                node.kind(),
                SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
            ) && matches!(
                target,
                Type::Record { .. } | Type::Array { .. } | Type::Map { .. } | Type::Union { .. }
            ) {
                return Ok(value);
            }

            if !matches!(target, Type::Dyn | Type::Null | Type::Undefined) {
                return self.coerce(value, target, node);
            }
        }
        if !matches!(value.ty(), Type::Union { .. }) {
            return Ok(value);
        }
        // An unreachable checker view has no runtime payload to project.
        // Source updates may make the cell observable again; retain its
        // owning tags rather than demanding a representation for never.
        let checked = self.checker.get_type_at_location(node);
        if self.checker.ty(checked).flags.intersects(TypeFlags::NEVER) {
            return Ok(value);
        }
        let target = self.ty(node)?;
        if value.ty() == target {
            return Ok(value);
        }
        // Unit values have no standalone IR storage. Keep the tagged value
        // for equality tests even when the checker already knows its tag.
        if matches!(target, Type::Null | Type::Undefined)
            && matches!(value.ty(), Type::Union { .. })
        {
            return Ok(value);
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if symbol != 0 {
                let declared = self
                    .checker
                    .get_type_of_symbol(source_frontend::prelude::SymbolId(symbol));
                if !self.source_has_undefined(declared)
                    && self.argument_may_be_absent(node, &mut HashSet::new())
                {
                    // The checker can omit absent indexed values or erase a
                    // non-null assertion. It has not proven the runtime tag.
                    return Ok(value);
                }
            }
        }
        if let Type::Union { union_id } = value.ty()
            && let Some(tag) = self.unions[union_id].arms.iter().position(|a| *a == target)
        {
            return Ok(Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        // Literal domains widen to one primitive representation. Other
        // refinements need an explicit IR operation rather than a Rust cast.
        Err(self.refuse(node, "flow narrowing has no native projection"))
    }

    pub(super) fn expected_expression(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        let value = self.expected_expression_inner(node, target);
        if matches!(
            node.kind(),
            SyntaxKind::CallExpression | SyntaxKind::NewExpression
        ) && !matches!(&value, Ok(Expr::Intrinsic { .. } | Expr::BytesNew { .. }))
            && !matches!(&value, Ok(Expr::LibCall { r#fn, .. }) if r#fn == "buffer.alloc")
        {
            self.var_call_effects();
        }
        value
    }

    fn expected_expression_inner(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        if matches!(target, Type::F64 | Type::String | Type::Bool)
            && self.bytes_named_key_value(node, &mut HashSet::new())
        {
            return Err(self.refuse(node, "typed array named-key value requires an owning dynamic contract"));
        }
        if target == Type::Dyn && node.kind() == SyntaxKind::Identifier {
            // An unknown-typed consumer receives the live value, not a
            // checker-only projection that can lose object identity or tags.
            let value = self.condition_value(node)?;
            return self.coerce(value, target, node);
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        {
            let value = self.optional_access(node)?;
            return self.coerce(value, target, node);
        }
        if matches!(target, Type::Promise { .. })
            && node.kind() == SyntaxKind::CallExpression
            && let Some(value) = self.promise_call_expected(node, Some(target.clone()))?
        {
            return Ok(value);
        }
        if let Some(value) = self.contextual_callable(node, &target)? {
            return Ok(value);
        }

        if target == Type::Dyn
            && matches!(
                node.kind(),
                SyntaxKind::ObjectLiteralExpression | SyntaxKind::ArrayLiteralExpression
            )
        {
            return self.dynamic_literal(node);
        }
        if target == Type::Dyn
            && matches!(
                node.kind(),
                SyntaxKind::ArrowFunction
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::MethodDeclaration
            )
        {
            let value = self.closure(node, None)?;
            return self.coerce(value, target, node);
        }
        match node.kind() {
            SyntaxKind::CallExpression
                if matches!(target, Type::Array { .. }) && self.is_array_map(node) =>
            {
                self.array_map(node, Some(target))
            }
            SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression => {
                self.expected_expression(node.expression(), target)
            }
            SyntaxKind::NewExpression if matches!(target, Type::Map { .. }) => {
                self.map_new_expected(node, Some(target))
            }
            SyntaxKind::NewExpression if matches!(target, Type::Set { .. }) => {
                self.set_new(node, Some(target))
            }
            SyntaxKind::ArrayLiteralExpression => {
                if let Type::Record { shape_id } = &target
                    && self.records[*shape_id].tuple
                {
                    return self.tuple_literal(node, target);
                }
                let sequence = match &target {
                    Type::Array { .. } => target.clone(),
                    Type::Union { union_id } => {
                        let sequences = self.unions[*union_id]
                            .arms
                            .iter()
                            .filter(|t| matches!(t, Type::Array { .. }) || matches!(t, Type::Record { shape_id } if self.records[*shape_id].tuple))
                            .cloned()
                            .collect::<Vec<_>>();
                        if sequences.len() != 1 {
                            return Err(
                                self.refuse(node, "array literal needs one native sequence arm")
                            );
                        }
                        sequences[0].clone()
                    }
                    _ => return Err(self.refuse(node, "array literal needs a native array target")),
                };
                if matches!(sequence, Type::Record { .. }) {
                    let value = self.tuple_literal(node, sequence)?;
                    return self.coerce(value, target, node);
                }
                let array = sequence;
                let Type::Array { elem } = &array else {
                    unreachable!()
                };
                if node
                    .elements()
                    .into_iter()
                    .any(|element| element.kind() == SyntaxKind::SpreadElement)
                {
                    let value = self.array_spread_literal(node, array)?;
                    return self.coerce(value, target, node);
                }
                let elems = node
                    .elements()
                    .into_iter()
                    .map(|n| self.expected_expression(n, (**elem).clone()))
                    .collect::<Result<Vec<_>, _>>()?;
                let value = Expr::ArrayLit {
                    elems,
                    r#type: array,
                    loc: self.loc(node),
                };
                self.coerce(value, target, node)
            }
            SyntaxKind::ArrowFunction
            | SyntaxKind::FunctionExpression
            | SyntaxKind::MethodDeclaration => {
                if let Type::Union { union_id } = target {
                    let functions = self.unions[union_id]
                        .arms
                        .iter()
                        .filter(|a| matches!(a, Type::Func { .. }))
                        .cloned()
                        .collect::<Vec<_>>();
                    if functions.len() != 1 {
                        return Err(self
                            .refuse(node, "callback union needs exactly one function signature"));
                    }
                    let value = self.closure(node, Some(functions[0].clone()))?;
                    self.coerce(value, Type::Union { union_id }, node)
                } else {
                    self.closure(node, Some(target))
                }
            }
            SyntaxKind::ObjectLiteralExpression if matches!(target, Type::Union { .. }) => {
                let Type::Union { union_id } = target else {
                    unreachable!();
                };
                let choice = self
                    .literal_choices
                    .get(&declarations::Key::of(node))
                    .cloned()
                    .or_else(|| self.contextual_union_literal(node));
                if let Some(choice) = choice
                    && self.unions[union_id].arms.contains(&choice)
                {
                    let value = self.record_literal(node, choice)?;
                    return self.coerce(value, target, node);
                }
                // A single represented record arm is unambiguous (for example
                // Record | undefined). Multiple layouts need the checked choice.
                let matches = self.unions[union_id]
                    .arms
                    .iter()
                    .filter(|ty| matches!(ty, Type::Record { .. }))
                    .cloned()
                    .collect::<Vec<_>>();
                if matches.len() != 1 {
                    if let Some(value) = self.union_spread(node, target.clone())? {
                        return Ok(value);
                    }
                    return Err(
                        self.refuse(node, "object literal needs one assignable native union arm")
                    );
                }
                let value = self.record_literal(node, matches[0].clone())?;
                self.coerce(value, target, node)
            }
            SyntaxKind::ObjectLiteralExpression if matches!(target, Type::Record { .. }) => {
                self.record_literal(node, target)
            }
            SyntaxKind::ParenthesizedExpression | SyntaxKind::SatisfiesExpression => {
                self.expected_expression(node.expression(), target)
            }
            SyntaxKind::ConditionalExpression => {
                let value = self.condition_value(node.condition())?;
                let cond = Box::new(self.condition(value, node.condition())?);
                let before = self.var_defined.clone();
                if let Some(symbols) = self.guarded_vars(node.condition(), true) {
                    self.var_defined.extend(symbols);
                }
                let then = Box::new(self.expected_expression(node.when_true(), target.clone())?);
                let then_defined = self.var_defined.clone();
                self.var_defined = before;
                if let Some(symbols) = self.guarded_vars(node.condition(), false) {
                    self.var_defined.extend(symbols);
                }
                let else_ = Box::new(self.expected_expression(node.when_false(), target.clone())?);
                // Either arm can execute and can invalidate a captured slot.
                // Only facts surviving both paths remain available afterward.
                self.var_defined = then_defined
                    .intersection(&self.var_defined)
                    .copied()
                    .collect();
                Ok(Expr::Ternary {
                    cond,
                    then,
                    else_,
                    r#type: target,
                    loc: self.loc(node),
                })
            }
            _ => {
                let value = self.expression(node)?;
                if let Some(narrowed) = self.guarded_capture_argument(node, value.clone(), &target)
                {
                    return Ok(narrowed);
                }
                if let Some(narrowed) = self.guarded_derived_argument(node, value.clone(), &target)
                {
                    return Ok(narrowed);
                }
                self.coerce(value, target, node)
            }
        }
    }

    pub(super) fn record_literal(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        let properties = node.properties().into_iter().collect::<Vec<_>>();
        let Type::Record { shape_id } = target else {
            return Err(self.refuse(node, "record literal needs a closed shape"));
        };
        let record = &self.records[shape_id];
        let has_extra = record.index_value.is_none()
            && properties.iter().any(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment
                        | SyntaxKind::ShorthandPropertyAssignment
                        | SyntaxKind::MethodDeclaration
                ) && self
                    .data_property_name(property.name())
                    .is_some_and(|name| !record.fields.iter().any(|field| field.name == name))
            });
        if has_extra {
            let source = self.ty(node)?;
            if source != target
                && matches!(source, Type::Record { .. })
                && ir::record_views::view_pairs(&source, &target, &self.records, &self.unions)
                    .is_some()
            {
                // Keep every source property in its complete owning
                // layout, then project a view without dropping keys.
                let value = self.record_literal(node, source)?;
                return self.coerce(value, target, node);
            }
        }
        if properties
            .iter()
            .any(|p| p.kind() == SyntaxKind::SpreadAssignment)
        {
            return self.construct_record(node, target, properties);
        }
        self.record_literal_fields(node, target, properties)
    }

    pub(super) fn record_literal_fields(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            return Err(self.refuse(node, "record literal needs a closed shape"));
        };
        if self.callables.contains_key(&shape_id)
            || self.enum_shape(shape_id)
            || self.is_data_view(&Type::Record { shape_id })
        {
            return Err(self.refuse(
                node,
                "data literals cannot manufacture callable or enum namespace identities",
            ));
        }
        let record = self.records[shape_id].clone();
        if record.tuple {
            return Err(self.refuse(node, "object literals cannot initialize tuple layouts"));
        }
        let mut seen = HashSet::new();
        let mut fields = Vec::new();
        for property in properties {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) || self.data_property_name(property.name()).is_none()
            {
                return Err(self.refuse(property, "only named data properties are ported"));
            }
            let name = self.data_property_name(property.name()).unwrap();
            // __proto__ in colon notation sets a prototype, not an own slot.
            if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                return Err(self.refuse(property, "object prototype setters are not ported"));
            }
            let field = record.fields.iter().find(|f| f.name == name);
            let target = field
                .map(|f| f.r#type.clone())
                .or_else(|| record.index_value.clone())
                .ok_or_else(|| self.refuse(property, "record width projection is not ported"))?;
            if !seen.insert(name.clone()) {
                return Err(self.refuse(property, "duplicate record properties are not ported"));
            }
            let value = self.object_property_value(property, target)?;
            fields.push(ir::FieldInit {
                name,
                value,
                absent: false,
                overflow: field.is_none(),
            });
        }
        for field in &record.fields {
            if !seen.contains(&field.name) {
                let value = Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                };
                let value = self.coerce(value, field.r#type.clone(), node)?;
                fields.push(ir::FieldInit {
                    name: field.name.clone(),
                    value,
                    absent: true,
                    overflow: false,
                });
            }
        }
        Ok(Expr::RecordLit {
            fields,
            r#type: target,
            loc: self.loc(node),
        })
    }

    pub(super) fn record_get(&mut self, node: Node) -> Result<Expr, String> {
        let obj = if node.expression().kind() == SyntaxKind::SuperKeyword {
            self.static_super_receiver(node)?
        } else {
            self.expression(node.expression())?
        };
        let obj = self.live_member_receiver(node.expression(), obj);
        if obj.ty() == Type::Dyn || matches!(obj.ty(), Type::Func { .. } | Type::Classval { .. }) {
            if matches!(obj.ty(), Type::Func { .. } | Type::Classval { .. }) {
                self.function_data_key(node, node.name().text())?;
            }
            let class = matches!(obj.ty(), Type::Classval { .. });
            let obj = self.class_data_receiver(obj, node.name().text(), node)?;
            let key = Expr::StrLit {
                value: node.name().text().into(),
                r#type: Type::String,
                loc: self.loc(node),
            };
            let value = self.dynamic_get(node, obj, key);
            return if class {
                if self.static_forward_read(node) {
                    return Err(self.refuse(node, "static field read before initialization needs an undefined-aware contract"));
                }
                let ty = self.ty(node)?;
                let finite_constructors = matches!(ty, Type::Union { union_id }
                    if self.unions[union_id].arms.len() >= 2
                        && self.unions[union_id].arms.iter().all(|arm| matches!(arm, Type::Classval { .. })));
                if !finite_constructors
                    && self.native_type_contains(&ty, |part| matches!(part, Type::Classval { .. }))
                {
                    return Err(self.refuse(node, "mutable class constructor properties require dynamic construction identity"));
                }
                self.coerce(value, ty, node)
            } else { Ok(value) };
        }
        if self.array_view(&obj.ty()) && node.name().text() == "length" {
            return self.array_length(node, obj);
        }
        if matches!(obj.ty(), Type::Union { .. }) {
            if self.nullable_record(&obj.ty()).is_some() {
                return self.nullable_record_get(node, obj);
            }
            return self.union_record_get(node, obj, node.name().text());
        }
        if matches!(obj.ty(), Type::Map { .. }) && node.name().text() == "size" {
            return self.map_intrinsic(node, obj, "size", vec![]);
        }
        if matches!(obj.ty(), Type::Set { .. }) && node.name().text() == "size" {
            return self.set_intrinsic(node, obj, "size", vec![]);
        }
        let Type::Record { shape_id } = obj.ty() else {
            return Err(self.refuse(
                node,
                &format!(
                    "property receiver has no closed record representation: {:?}",
                    obj.ty()
                ),
            ));
        };
        if self.records[shape_id].tuple && node.name().text() == "length" {
            let helper =
                helpers::Helper::new("tuple_length", vec![obj.ty()], Type::F64, self.loc(node));
            let mut function = helper.function;
            function.body.push(Stmt::Return {
                value: Some(Expr::NumLit {
                    value: self.records[shape_id].fields.len() as f64,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }),
                loc: self.loc(node),
            });
            let callee = self.install_helper(function);
            return Ok(Expr::Call {
                callee,
                args: vec![obj],
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        if self.records[shape_id].index_value.is_some() {
            let key = Expr::StrLit {
                value: node.name().text().into(),
                r#type: Type::String,
                loc: self.loc(node),
            };
            return self.dictionary_get(node, obj, key);
        }
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == node.name().text())
            .ok_or_else(|| self.refuse(node, "unknown native record field"))?;
        let value = Expr::RecordGet {
            obj: Box::new(obj),
            shape_id: format!("r{shape_id}"),
            field: field.name.clone(),
            r#type: field.r#type.clone(),
            loc: self.loc(node),
        };
        if self.planned_field_read(node) {
            Ok(value)
        } else {
            self.narrowed(value, node)
        }
    }

    pub(super) fn record_set(&mut self, node: Node) -> Result<Stmt, String> {
        self.guard_raw_json_write(node)?;
        let member = node.left();
        if member.name().text() == "__proto__" {
            return Err(self.refuse(member, "ordinary prototype writes are not ported"));
        }
        let obj = self.expression(member.expression())?;
        let obj = self.live_member_receiver(member.expression(), obj);
        if self.nullable_record(&obj.ty()).is_some() {
            return self.nullable_record_set(node, obj);
        }
        if member.name().text() == "length" && matches!(obj.ty(), Type::Array { .. }) {
            let length = self.expected_expression(node.right(), Type::F64)?;
            return Ok(Stmt::ArraySetLength {
                arr: obj,
                length,
                loc: self.loc(node),
            });
        }
        if obj.ty() == Type::Dyn
            || matches!(obj.ty(), Type::Func { .. })
            || matches!(obj.ty(), Type::Classval { .. })
            || matches!(obj.ty(), Type::Array { elem } if *elem == Type::Dyn)
        {
            if matches!(obj.ty(), Type::Func { .. } | Type::Classval { .. }) {
                self.function_data_key(member, member.name().text())?;
            }
            let obj = self.class_data_receiver(obj, member.name().text(), node)?;
            let key = Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            };
            return self.dynamic_property_set(node, obj, key);
        }
        let Type::Record { shape_id } = obj.ty() else {
            return Err(self.refuse(node, "property assignment requires a closed record"));
        };
        if self.records[shape_id].index_value.is_some() {
            return self.dictionary_set_value(node, obj);
        }
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == member.name().text())
            .cloned()
            .ok_or_else(|| self.refuse(member, "unknown native record field"))?;
        let value = self.expected_expression(node.right(), field.r#type)?;
        Ok(Stmt::RecordSet {
            obj,
            shape_id: format!("r{shape_id}"),
            field: field.name,
            value,
            loc: self.loc(node),
        })
    }

    pub(super) fn dynamic_property_set(
        &mut self,
        node: Node,
        obj: Expr,
        key: Expr,
    ) -> Result<Stmt, String> {
        if matches!(&key, Expr::StrLit { value, .. } if value == "__proto__") {
            return Err(self.refuse(node, "dynamic prototype writes are not ported"));
        }
        let value = self.expected_expression(node.right(), Type::Dyn)?;
        self.checked_dynamic_property_set(node, obj, key, value)
    }

    pub(super) fn binary(&mut self, node: Node, op: &str) -> Result<Expr, String> {
        if matches!(op, "==" | "!=") {
            for (value, unit) in [(node.left(), node.right()), (node.right(), node.left())] {
                if primitives::primitive_source(unit).kind() == SyntaxKind::NullKeyword {
                    // Nullish equality does not invoke ToPrimitive. Observe
                    // the live owning tag once, including a stale checker view.
                    let value = self.condition_value(value)?;
                    let value = self.primitive_capture(value, node)?;
                    return Ok(Expr::DynTest {
                        value: Box::new(self.coerce(value, Type::Dyn, node)?),
                        test: "nullish".into(),
                        negated: op == "!=",
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    });
                }
            }
        }
        if matches!(op, "<" | "<=" | ">" | ">=") {
            return self.relational(node, op);
        }
        if op == "in" {
            return self.object_presence(node);
        }
        if matches!(op, "&&" | "||" | "??") {
            return self.logical(node, op);
        }
        if matches!(op, "===" | "!==") {
            for (test, kind) in [(node.left(), node.right()), (node.right(), node.left())] {
                if test.kind() == SyntaxKind::TypeOfExpression
                    && kind.kind() == SyntaxKind::StringLiteral
                {
                    let value = self.condition_value(test.expression())?;
                    if value.ty() == Type::Dyn
                        && matches!(
                            kind.text(),
                            "bigint"
                                | "number"
                                | "string"
                                | "boolean"
                                | "symbol"
                                | "undefined"
                                | "object"
                                | "function"
                        )
                    {
                        return Ok(Expr::DynTest {
                            value: Box::new(value),
                            test: kind.text().into(),
                            negated: op == "!==",
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                }
            }
        }
        // Equality observes the live cell, including tags changed by a call
        // or a previous loop iteration. A checker projection can be stale.
        let mut left = if matches!(op, "===" | "!==") {
            self.condition_value(node.left())?
        } else {
            self.expression(node.left())?
        };
        let mut right = if matches!(op, "===" | "!==") {
            self.condition_value(node.right())?
        } else {
            self.expression(node.right())?
        };
        if op == "+" && (left.ty() == Type::String || right.ty() == Type::String) {
            return self.string_addition(left, right, node);
        }
        if matches!(op, "===" | "!==")
            && self.is_data_view(&left.ty())
            && self.is_data_view(&right.ty())
        {
            let boxed_view = |value, site| Expr::DynFrom {
                value: Box::new(self.data_view_storage(site, value)),
                r#type: Type::Dyn,
                loc: self.loc(site),
            };
            return Ok(Expr::DynScalarEq {
                left: Box::new(boxed_view(left, node.left())),
                right: Box::new(boxed_view(right, node.right())),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        let data_records = |ty: Type| {
            let arms = match ty.clone() {
                Type::Union { union_id } => self.unions[union_id].arms.clone(),
                ty => vec![ty],
            };
            !ir::contains_set(&ty, &self.records, &self.unions) && arms.iter().all(|ty| matches!(ty, Type::Record { shape_id } if !self.records[*shape_id].tuple && self.records[*shape_id].index_value.is_none() && !self.records[*shape_id].fields.iter().any(|f| f.name == callables::CALL_FIELD)))
        };
        if matches!(op, "===" | "!==")
            && left.ty() == right.ty()
            && matches!(left.ty(), Type::Record { .. })
            && data_records(left.ty())
        {
            // Compare the owning record handles directly. Dynamic boxing can
            // copy records in a backend and would change object identity.
            let union = self.intern_union(vec![left.ty(), Type::Undefined]).unwrap();
            let Type::Union { union_id } = union else {
                unreachable!()
            };
            return Ok(Expr::UnionEq {
                union_id: format!("u{union_id}"),
                negated: op == "!==",
                same_value: false,
                left: Box::new(self.coerce(left, union.clone(), node.left())?),
                right: Box::new(self.coerce(right, union, node.right())?),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==") && data_records(left.ty()) && data_records(right.ty()) {
            return Ok(Expr::DynScalarEq {
                left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==") && (left.ty() == Type::Dyn || right.ty() == Type::Dyn) {
            return Ok(Expr::DynScalarEq {
                left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==")
            && matches!(left.ty(), Type::Func { .. })
            && matches!(right.ty(), Type::Func { .. })
            && left.ty() != right.ty()
        {
            // Function identity is independent of the native call signature.
            // Use the owning callable identity when no shared typed ABI exists.
            return Ok(Expr::DynScalarEq {
                left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==") {
            if matches!(left.ty(), Type::Func { .. }) {
                right = self.callable_body(right, node.right())?;
            } else if matches!(right.ty(), Type::Func { .. }) {
                left = self.callable_body(left, node.left())?;
            }
        }
        if matches!(op, "===" | "!==") {
            // Shared IR binary equality is numeric/reference-layout-specific.
            // Regex identity already has a portable union equality contract.
            if left.ty() == right.ty()
                && matches!(
                    left.ty(),
                    Type::Regex | Type::Symbol | Type::Classval { .. }
                )
            {
                let union = self.intern_union(vec![left.ty(), Type::Undefined]).unwrap();
                let Type::Union { union_id } = union else {
                    unreachable!()
                };
                return Ok(Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: op == "!==",
                    same_value: false,
                    left: Box::new(self.coerce(left, union.clone(), node.left())?),
                    right: Box::new(self.coerce(right, union, node.right())?),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            if matches!(left.ty(), Type::Object { .. })
                && matches!(right.ty(), Type::Object { .. })
                && left.ty() != right.ty()
            {
                let (Type::Object { class_name: a }, Type::Object { class_name: b }) =
                    (left.ty(), right.ty())
                else {
                    unreachable!()
                };
                let common = self.classes.layouts.iter().flatten().find(|class| {
                    self.classes.subclass(&a, &class.name) && self.classes.subclass(&b, &class.name)
                });
                if let Some(common) = common {
                    let root = Type::Object {
                        class_name: common.name.clone(),
                    };
                    left = self.coerce(left, root.clone(), node.left())?;
                    right = self.coerce(right, root, node.right())?;
                } else {
                    return Ok(Expr::DynScalarEq {
                        left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                        right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                        negated: op == "!==",
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    });
                }
            }
            if matches!(left, Expr::UnitLit { .. }) && matches!(right, Expr::UnitLit { .. }) {
                return Ok(Expr::BoolLit {
                    value: (left.ty() == right.ty()) != (op == "!=="),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            // Only unit comparisons can become tag tests: comparing two
            // payload values requires JS equality, not tag equality.
            let mut test = None;
            for (value, unit) in [(&left, &right), (&right, &left)] {
                if let Type::Union { union_id } = value.ty()
                    && matches!(unit, Expr::UnitLit { .. })
                    && let Some(tag) = self.unions[union_id]
                        .arms
                        .iter()
                        .position(|a| *a == unit.ty())
                {
                    test = Some((union_id, tag));
                }
            }
            if let Some((union_id, tag)) = test {
                return Ok(Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    negated: op == "!==",
                    value: Box::new(if matches!(left, Expr::UnitLit { .. }) {
                        right
                    } else {
                        left
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            if (matches!(left, Expr::UnitLit { .. }) || matches!(right, Expr::UnitLit { .. }))
                && !matches!(left.ty(), Type::Union { .. })
                && !matches!(right.ty(), Type::Union { .. })
            {
                let union = self
                    .intern_union(vec![left.ty(), right.ty()])
                    .ok_or_else(|| {
                        self.refuse(node, "unit comparison has no native representation")
                    })?;
                let Type::Union { union_id } = union else {
                    unreachable!()
                };
                return Ok(Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: op == "!==",
                    same_value: false,
                    left: Box::new(self.coerce(left, union.clone(), node.left())?),
                    right: Box::new(self.coerce(right, union, node.right())?),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            if matches!(left.ty(), Type::Union { .. })
                && matches!(right.ty(), Type::Union { .. })
                && left.ty() != right.ty()
                && self.dynamic_erasure_reason(&left.ty()).is_none()
                && self.dynamic_erasure_reason(&right.ty()).is_none()
            {
                // Equality observes both complete domains. Projecting one
                // operand into the other's union could discard a live tag.
                return Ok(Expr::DynScalarEq {
                    left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                    right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                    negated: op == "!==",
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            let union = if matches!(left.ty(), Type::Union { .. }) {
                left.ty()
            } else {
                right.ty()
            };
            if let Type::Union { union_id } = union {
                let left = self.coerce(left, union.clone(), node.left())?;
                let right = self.coerce(right, union, node.right())?;
                return Ok(Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: op == "!==",
                    same_value: false,
                    left: Box::new(left),
                    right: Box::new(right),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
        }
        if matches!(op, "&" | "|" | "^" | "<<" | ">>" | ">>>")
            && (left.ty() != Type::F64 || right.ty() != Type::F64)
        {
            return self.numeric_binary(left, right, op, node);
        }
        if left.ty() == Type::Bigint && right.ty() == Type::Bigint {
            if matches!(op, "===" | "!==") {
                return Ok(Expr::DynScalarEq {
                    left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                    right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                    negated: op == "!==",
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            let operation = match op {
                "+" => "add",
                "-" => "sub",
                "*" => "mul",
                "/" => "div",
                "%" => "rem",
                "**" => "pow",
                _ => return Err(self.refuse(node, "BigInt operator is not ported")),
            };
            self.ensure_exception_classes(node)?;
            return Ok(self.bigint_operation(
                &format!("bigint.{operation}"),
                vec![left, right],
                node,
            ));
        }
        if matches!(op, "+" | "-" | "*" | "/" | "%" | "**")
            && (left.ty() != Type::F64 || right.ty() != Type::F64)
        {
            return self.numeric_binary(left, right, op, node);
        }
        let supported = if matches!(op, "===" | "!==") {
            left.ty() == right.ty()
                && matches!(
                    left.ty(),
                    Type::F64
                        | Type::String
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::Record { .. }
                        | Type::Func { .. }
                        | Type::Array { .. }
                        | Type::Map { .. }
                        | Type::Set { .. }
                        | Type::Object { .. }
                        | Type::Regex
                        | Type::Bytes { .. }
                        | Type::Promise { .. }
                        | Type::Child
                )
        } else {
            left.ty() == Type::F64 && right.ty() == Type::F64
        };
        if !supported {
            return Err(self.refuse(node, "binary operand coercion is not ported"));
        }
        if left.ty() == Type::String {
            return Ok(Expr::StrEq {
                negated: op == "!==",
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        Ok(Expr::Bin {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type: if matches!(
                op,
                "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>"
            ) {
                Type::F64
            } else {
                Type::Bool
            },
            loc: self.loc(node),
        })
    }
}
