//! Closed data records share an owning property store; IR shapes remain typed views.
use super::*;

pub(super) fn shared(record: &crate::ir::Record, module: &Emission<'_>) -> bool {
    module.record_is_shared(record.id)
}

pub(super) fn direct_records(module: &Module) -> std::collections::HashSet<usize> {
    // Tuples always keep their array-backed typed layout. A projected tuple
    // stores the original array in `R::source`, so it can preserve JavaScript
    // identity without being collapsed into the ordinary-object property
    // store. Closed scalar data layouts can also live as Rust structs with
    // unboxed slots; other records retain the shared property store.
    let mut direct = module
        .records
        .iter()
        .filter(|record| {
            record.tuple
                || (record.index_value.is_none()
                    && !record.fields.is_empty()
                    && record.fields.iter().all(|field| {
                        matches!(
                            field.r#type,
                            Type::F64 | Type::Bool | Type::String | Type::Bigint
                        )
                    }))
        })
        .map(|record| record.id)
        .collect::<std::collections::HashSet<_>>();

    // A scalar layout nested inside another record participates in the outer
    // record's identity and structural-view plan. Keep it shared until the IR
    // can prove field-by-field that the containing layout never projects.
    fn nested_record_ids(
        ty: &Type,
        module: &Module,
        found: &mut std::collections::HashSet<usize>,
        seen_unions: &mut std::collections::HashSet<usize>,
    ) {
        match ty {
            Type::Record { shape_id } => {
                found.insert(*shape_id);
            }
            Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
                nested_record_ids(elem, module, found, seen_unions)
            }
            Type::Map { key, value } => {
                nested_record_ids(key, module, found, seen_unions);
                nested_record_ids(value, module, found, seen_unions);
            }
            Type::Func { params, ret, .. } => {
                for param in params {
                    nested_record_ids(param, module, found, seen_unions);
                }
                nested_record_ids(ret, module, found, seen_unions);
            }
            Type::Generator {
                yield_type,
                return_type,
                next_type,
                ..
            } => {
                nested_record_ids(yield_type, module, found, seen_unions);
                nested_record_ids(return_type, module, found, seen_unions);
                nested_record_ids(next_type, module, found, seen_unions);
            }
            Type::Union { union_id } if seen_unions.insert(*union_id) => {
                if let Some(union) = module.unions.get(*union_id) {
                    for arm in &union.arms {
                        nested_record_ids(arm, module, found, seen_unions);
                    }
                }
            }
            _ => {}
        }
    }
    let mut nested = std::collections::HashSet::new();
    for record in &module.records {
        for field in &record.fields {
            nested_record_ids(
                &field.r#type,
                module,
                &mut nested,
                &mut std::collections::HashSet::new(),
            );
        }
    }
    direct.retain(|shape_id| module.records[*shape_id].tuple || !nested.contains(shape_id));

    let mut has_dynamic_freeze = false;
    module.visit_expressions(&mut |expr| {
        if matches!(expr, Expr::LibCall { r#fn, .. } if matches!(r#fn.as_str(), "dyn.freezeValue" | "dyn.isFrozenValue" | "dyn.keySetSloppy" | "dyn.keySetComputedSloppy")) {
            has_dynamic_freeze = true;
        }
    });
    if has_dynamic_freeze {
        // An erased value can alias any ordinary record in the program. Its
        // integrity metadata must live on the same owning property store as
        // every typed view rather than on a detached scalar-record projection.
        direct.retain(|id| module.records[*id].tuple);
    }

    let mut make_shared = |ty: &Type| {
        fn remove(
            ty: &Type,
            direct: &mut std::collections::HashSet<usize>,
            module: &Module,
            seen_records: &mut std::collections::HashSet<usize>,
            seen_unions: &mut std::collections::HashSet<usize>,
        ) {
            match ty {
                Type::Record { shape_id } => {
                    let record = module.records.get(*shape_id);
                    if record.is_none_or(|record| !record.tuple) {
                        direct.remove(shape_id);
                    }
                    if !seen_records.insert(*shape_id) {
                        return;
                    }
                    if let Some(record) = record {
                        for field in &record.fields {
                            remove(&field.r#type, direct, module, seen_records, seen_unions);
                        }
                        if let Some(index) = &record.index_value {
                            remove(index, direct, module, seen_records, seen_unions);
                        }
                    }
                }
                Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
                    remove(elem, direct, module, seen_records, seen_unions)
                }
                Type::Map { key, value } => {
                    remove(key, direct, module, seen_records, seen_unions);
                    remove(value, direct, module, seen_records, seen_unions);
                }
                Type::Func { params, ret, .. } => {
                    for param in params {
                        remove(param, direct, module, seen_records, seen_unions);
                    }
                    remove(ret, direct, module, seen_records, seen_unions);
                }
                Type::Generator {
                    yield_type,
                    return_type,
                    next_type,
                    ..
                } => {
                    remove(yield_type, direct, module, seen_records, seen_unions);
                    remove(return_type, direct, module, seen_records, seen_unions);
                    remove(next_type, direct, module, seen_records, seen_unions);
                }
                Type::Union { union_id } if seen_unions.insert(*union_id) => {
                    if let Some(union) = module.unions.get(*union_id) {
                        for arm in &union.arms {
                            remove(arm, direct, module, seen_records, seen_unions);
                        }
                    }
                }
                _ => {}
            }
        }
        remove(
            ty,
            &mut direct,
            module,
            &mut std::collections::HashSet::new(),
            &mut std::collections::HashSet::new(),
        );
    };

    module.visit_expressions(&mut |expr| match expr {
        // Structural views, own-property reconstruction and checked values
        // must keep a common property store and object identity.
        Expr::LibCall {
            r#fn, args, r#type, ..
        } if r#fn.starts_with("record.") => {
            make_shared(r#type);
            for arg in args {
                make_shared(&arg.ty());
            }
        }
        Expr::RecordKeyGet { obj, .. } => make_shared(&obj.ty()),
        // An assign target can be a union of record and object layouts. Its
        // dynamic view must keep the actual record's mutable owning store.
        Expr::LibCall { r#fn, args, .. } if r#fn == "dyn.objectAssignCopy" => {
            if let Some(Expr::DynFrom { value, .. }) = args.first() {
                make_shared(&value.ty());
            }
        }
        // A checked conversion from an erased ordinary object needs the
        // identity-preserving representation; a direct struct cannot adopt
        // that object's storage without a copy.
        Expr::DynCheck { r#type, .. } => make_shared(r#type),
        // A callable forwarded through Dyn boxes its concrete parameter and
        // result ABI before the target view checks them. Records nested in
        // that source function therefore need the identity-preserving shared
        // store just like records that are themselves checked from Dyn.
        Expr::DynFrom { value, .. } if matches!(value.ty(), Type::Func { .. }) => {
            make_shared(&value.ty())
        }
        // An erased record can be mutated, deleted from, or observed by
        // identity through the dynamic view. Keep the original property store
        // instead of boxing a detached scalar-layout value. Union erasure can
        // carry such a record too, so retain each represented record arm.
        Expr::DynFrom { value, .. }
            if matches!(value.ty(), Type::Record { .. } | Type::Union { .. }) =>
        {
            make_shared(&value.ty())
        }
        _ => {}
    });
    fn collect_computed_sets(body: &[Stmt], found: &mut Vec<Type>) {
        for statement in body {
            match statement {
                Stmt::RecordKeySet { obj, .. } => found.push(obj.ty()),
                Stmt::GeneratorForOf { body, .. }
                | Stmt::While { body, .. }
                | Stmt::Block { body, .. } => collect_computed_sets(body, found),
                Stmt::Switch { cases, .. } => {
                    for case in cases {
                        collect_computed_sets(&case.body, found);
                    }
                }
                Stmt::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    collect_computed_sets(try_body, found);
                    if let Some(body) = catch_body {
                        collect_computed_sets(body, found);
                    }
                    if let Some(body) = finally_body {
                        collect_computed_sets(body, found);
                    }
                }
                Stmt::If { then, else_, .. } => {
                    collect_computed_sets(then, found);
                    if let Some(body) = else_ {
                        collect_computed_sets(body, found);
                    }
                }
                Stmt::Throw { .. }
                | Stmt::ArraySet { .. }
                | Stmt::BytesSet { .. }
                | Stmt::ArraySetLength { .. }
                | Stmt::FieldSet { .. }
                | Stmt::RecordSet { .. }
                | Stmt::Break { .. }
                | Stmt::Continue { .. }
                | Stmt::VarDecl { .. }
                | Stmt::Assign { .. }
                | Stmt::Expression { .. }
                | Stmt::Return { .. } => {}
            }
        }
    }
    let mut computed_sets = Vec::new();
    for function in &module.functions {
        collect_computed_sets(&function.body, &mut computed_sets);
    }
    for ty in &computed_sets {
        make_shared(ty);
    }
    direct
}

pub(super) fn definitions(out: &mut String) {
    out.push_str(
        r#"
// Typed record views and erased plain objects own the same property store.
// Refining an object to a record must never copy or change its identity.
type NativeRecordData = NativeMap<runtime::JsString, NativeValue>;
// Array views can expose one object under a narrower record tag. Remember the
// first owning tag without keeping the object alive, so assigning that same
// object back through the view checks it against its original array ABI.
#[derive(Clone)]
struct NativeArrayRecordOrigin(usize);
impl runtime::HeapValue for NativeArrayRecordOrigin {
    fn trace_value(&self, _: &mut runtime::Tracer<'_>) {}
}
fn native_array_preserve_record(value: NativeValue) -> NativeValue {
    if let NativeValue::Record(tag, object) = &value {
        let key = runtime::WeakKey::new(object);
        if runtime::weak_map_get::<NativeArrayRecordOrigin>(&key, &key).is_none() {
            runtime::weak_map_set(&key, &key, NativeArrayRecordOrigin(*tag));
        }
    }
    value
}
fn native_array_restore_record(value: NativeValue) -> NativeValue {
    match value {
        NativeValue::Record(tag, object) => {
            let key = runtime::WeakKey::new(&object);
            let original = runtime::weak_map_get::<NativeArrayRecordOrigin>(&key, &key).map_or(tag, |origin| origin.0);
            NativeValue::Record(original, object)
        }
        other => other,
    }
}
fn native_record_get<K: runtime::JsStringSource + ?Sized>(object: &runtime::Gc<NativeRecordData>, key: &K) -> NativeValue {
    let key = runtime::string(key);
    if key == "\0scriptc.call" && let Some(view) = native_callable_view(object) { return view.function; }
    if let Some(value) = native_getter_read(&native_callable_receiver(object), &key) { return value; }
    object.with(|data| data.entries.iter().find(|(name,_)| name == &key)
        .map(|(_, value)| value.clone()).unwrap_or(NativeValue::Undefined))
}
fn native_record_property<K: runtime::JsStringSource + ?Sized>(object: &runtime::Gc<NativeRecordData>, key: &K) -> NativeValue {
    let key = runtime::string(key);
    if key == "\0scriptc.call" && let Some(view) = native_callable_view(object) { return view.function; }
    if let Some(value) = native_getter_read(&native_callable_receiver(object), &key) { return value; }
    object.with(|data| data.entries.iter().find(|(name,_)| name == &key)
        .map(|(_, value)| value.clone())).unwrap_or_else(|| {
            native_instance_prototype(object)
                .map(|prototype| native_value_get(prototype, key.clone()))
                .unwrap_or_else(|| native_value_missing(key.well_formed_utf8().unwrap_or("")))
        })
}
// A typed RecordGet knows the declaration slot at compile time. Read that
// slot directly while its key still matches; object spreads, optional fields,
// deletion and structural views can all change the physical order, so those
// cases deliberately fall back to the complete property path.
fn native_record_slot_property<K: runtime::JsStringSource + ?Sized>(object: &runtime::Gc<NativeRecordData>, slot: usize, key: &K) -> NativeValue {
    let key = runtime::string(key);
    if key == "\0scriptc.call" && let Some(view) = native_callable_view(object) { return view.function; }
    if let Some(value) = native_getter_read(&native_callable_receiver(object), &key) { return value; }
    if let Some(value) = object.with(|data| data.entries.get(slot)
        .filter(|(name, _)| name == &key).map(|(_, value)| value.clone())) { return value; }
    native_record_property(object, &key)
}
fn native_record_define(entries: &mut Vec<(runtime::JsString, NativeValue)>, key: runtime::JsString, value: NativeValue) {
    if let Some((_, slot)) = entries.iter_mut().find(|(name,_)| *name == key) { *slot = value; }
    else { entries.push((key, value)); }
}
fn native_record_set(object: &runtime::Gc<NativeRecordData>, key: runtime::JsString, value: NativeValue) {
    if native_getter_write(&NativeValue::Object(object.clone()), &key, value.clone()) { return; }
    object.with_mut(|data| native_record_define(&mut data.entries, key, value));
}
fn native_record_slot_set(object: &runtime::Gc<NativeRecordData>, slot: usize, key: runtime::JsString, value: NativeValue) {
    if native_getter_write(&NativeValue::Object(object.clone()), &key, value.clone()) { return; }
    let value = object.with_mut(|data| {
        if let Some((name, stored)) = data.entries.get_mut(slot)
            && name == &key
        {
            *stored = value;
            return None;
        }
        Some(value)
    });
    if let Some(value) = value { native_record_set(object, key, value); }
}
"#,
    );
}

pub(super) fn read(
    ty: &Type,
    object: &str,
    shape_id: usize,
    field: &str,
    module: &Emission<'_>,
) -> String {
    let slot = module.records[shape_id]
        .declared_order
        .iter()
        .position(|name| name == field)
        .or_else(|| {
            module.records[shape_id]
                .fields
                .iter()
                .position(|candidate| candidate.name == field)
        })
        .expect("validated record field");
    values::checked_value(
        ty,
        &format!("native_record_slot_property(&({object}), {slot}, {field:?})"),
        module,
    )
}

pub(super) fn view(value: &Expr, function: &Function, module: &Emission<'_>) -> String {
    let Expr::LibCall {
        r#fn, args, r#type, ..
    } = value
    else {
        unreachable!()
    };
    let source = args[0].ty();
    let pairs = if r#fn == "record.checkedView" {
        crate::ir::record_views::dynamic_view_pairs(
            &source,
            r#type,
            &module.records,
            &module.unions,
        )
    } else {
        crate::ir::record_views::view_pairs(&source, r#type, &module.records, &module.unions)
    }
    .expect("validated record view");
    let tags =
        crate::ir::record_equivalence::record_representatives(&module.records, &module.unions);
    let result = |tag: usize| {
        let target = match r#type {
            Type::Union { union_id } => &module.unions[*union_id].arms[tag],
            target => target,
        };
        let value = if let Type::Record { shape_id } = target
            && module.records[*shape_id]
                .fields
                .iter()
                .any(|field| field.name == "\0scriptc.call")
        {
            format!(
                "native_callable_attach(value.clone(), native_record_get(&value, \"\\0scriptc.call\"), {})",
                tags[*shape_id]
            )
        } else {
            "value".into()
        };
        match r#type {
            Type::Union { union_id } => format!("U{union_id}::V{tag}({value})"),
            _ => value,
        }
    };
    match source {
        Type::Union { union_id } => {
            let arms = pairs
                .iter()
                .map(|(from, to)| format!("U{union_id}::V{from}(value) => {},", result(*to)))
                .collect::<String>();
            format!("match {} {{ {arms} }}", expr(&args[0], function, module))
        }
        _ => format!(
            "{{ let value = {}; {} }}",
            expr(&args[0], function, module),
            result(pairs[0].1)
        ),
    }
}
