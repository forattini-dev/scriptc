//! Complete record materialization with an explicit own-key plan.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    let mut demanded = std::collections::HashSet::new();
    module.visit_expressions(&mut |expr| {
        if let Expr::LibCall {
            r#fn,
            r#type: Type::Record { shape_id },
            ..
        } = expr
            && matches!(r#fn.as_str(), "record.cloneOwn" | "record.fromOwn")
        {
            demanded.insert(*shape_id);
        }
    });
    for record in module.records.iter().filter(|r| demanded.contains(&r.id)) {
        let id = record.id;
        writeln!(out, "fn record_from_own_{id}(template: runtime::Gc<R{id}>, own: NativeValue) -> runtime::Gc<R{id}> {{ let _ = template; let NativeValue::Object(own) = own else {{ runtime::throw_type_error(\"scriptc: own-value plan must be a native object\".into()) }}; let data = runtime::Gc::new(NativeRecordData {{ entries: own.with(|object| object.entries.clone()) }});").unwrap();
        for field in &record.fields {
            let optional = field.r#type == Type::Undefined
                || matches!(&field.r#type, Type::Union{union_id} if module.unions[*union_id].arms.contains(&Type::Undefined));
            if !optional {
                writeln!(out, "if !data.with(|o| o.entries.iter().any(|(k,_)| k == {:?})) {{ runtime::throw_type_error(\"scriptc: missing required record own key\".into()); }}", field.name).unwrap();
            }
            writeln!(
                out,
                "let _ = {};",
                record_storage::read(&field.r#type, "data.clone()", &field.name, module)
            )
            .unwrap();
        }
        out.push_str("data }\n");
        let allowed = record
            .fields
            .iter()
            .map(|f| format!("{:?}", f.name))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(out, "fn record_clone_own_{id}(source: runtime::Gc<R{id}>, order: runtime::JsArray<runtime::JsString>) -> runtime::Gc<R{id}> {{ let mut keys: Vec<runtime::JsString> = Vec::new(); let allowed: &[&str] = &[{allowed}]; let mut index = 0.0; while index < runtime::array_len(&order) {{ let key = runtime::array_get(&order, index); if !allowed.iter().any(|allowed| key == *allowed) || keys.contains(&key) {{ runtime::throw_type_error(\"scriptc: invalid record own-key plan\".into()); }} keys.push(key); index += 1.0; }}").unwrap();
        for field in &record.fields {
            let optional = field.r#type == Type::Undefined
                || matches!(&field.r#type, Type::Union { union_id } if module.unions[*union_id].arms.contains(&Type::Undefined));
            if !optional {
                writeln!(out, "if !keys.iter().any(|key| key == {:?}) {{ runtime::throw_type_error(\"scriptc: missing required record own key\".into()); }}", field.name).unwrap();
            }
        }
        writeln!(out, "let entries = keys.into_iter().map(|key| {{ let value = native_record_get(&source, &key); (key, value) }}).collect(); runtime::Gc::new(NativeRecordData {{ entries }}) }}").unwrap();
    }
}
