//! Closed data records share an owning property store; IR shapes remain typed views.
use super::*;

pub(super) fn shared(record: &crate::ir::Record) -> bool {
    !record.tuple && record.index_value.is_none()
}

pub(super) fn definitions(out: &mut String) {
    out.push_str(
        r#"
// Typed record views and erased plain objects own the same property store.
// Refining an object to a record must never copy or change its identity.
type NativeRecordData = NativeMap<runtime::JsString, NativeValue>;
fn native_record_get<K: runtime::JsStringSource + ?Sized>(object: &runtime::Gc<NativeRecordData>, key: &K) -> NativeValue {
    let key = runtime::string(key);
    object.with(|data| data.entries.iter().find(|(name,_)| name == &key)
        .map(|(_, value)| value.clone()).unwrap_or(NativeValue::Undefined))
}
fn native_record_property<K: runtime::JsStringSource + ?Sized>(object: &runtime::Gc<NativeRecordData>, key: &K) -> NativeValue {
    let key = runtime::string(key);
    object.with(|data| data.entries.iter().find(|(name,_)| name == &key)
        .map(|(_, value)| value.clone())).unwrap_or_else(|| native_value_missing(key.well_formed_utf8().unwrap_or("")))
}
fn native_record_define(entries: &mut Vec<(runtime::JsString, NativeValue)>, key: runtime::JsString, value: NativeValue) {
    if let Some((_, slot)) = entries.iter_mut().find(|(name,_)| *name == key) { *slot = value; }
    else { entries.push((key, value)); }
}
fn native_record_set(object: &runtime::Gc<NativeRecordData>, key: runtime::JsString, value: NativeValue) {
    object.with_mut(|data| native_record_define(&mut data.entries, key, value));
}
"#,
    );
}

pub(super) fn read(ty: &Type, object: &str, field: &str, module: &Module) -> String {
    values::checked_value(
        ty,
        &format!("native_record_property(&({object}), {field:?})"),
        module,
    )
}

pub(super) fn view(value: &Expr, function: &Function, module: &Module) -> String {
    let Expr::LibCall { args, r#type, .. } = value else {
        unreachable!()
    };
    let source = args[0].ty();
    let pairs =
        crate::ir::record_views::view_pairs(&source, r#type, &module.records, &module.unions)
            .expect("validated record view");
    let result = |tag: usize| match r#type {
        Type::Union { union_id } => format!("U{union_id}::V{tag}(value)"),
        _ => "value".into(),
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
