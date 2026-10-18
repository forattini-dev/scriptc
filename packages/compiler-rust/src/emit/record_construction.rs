//! Complete record materialization with an explicit own-key plan.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Module, out: &mut String) {
    let mut demanded = std::collections::HashSet::new();
    module.visit_expressions(&mut |expr| {
        if let Expr::LibCall {
            r#fn,
            r#type: Type::Record { shape_id },
            ..
        } = expr
            && r#fn == "record.cloneOwn"
        {
            demanded.insert(*shape_id);
        }
    });
    for record in module.records.iter().filter(|r| demanded.contains(&r.id)) {
        let id = record.id;
        let allowed = record
            .fields
            .iter()
            .map(|f| format!("{:?}", f.name))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(out, "fn record_clone_own_{id}(source: runtime::Gc<R{id}>, order: runtime::JsArray<runtime::JsString>) -> runtime::Gc<R{id}> {{ let mut keys: Vec<String> = Vec::new(); let allowed: &[&str] = &[{allowed}]; let mut index = 0.0; while index < runtime::array_len(&order) {{ let key = runtime::array_get(&order, index).to_string(); if !allowed.contains(&key.as_str()) || keys.contains(&key) {{ runtime::throw_type_error(\"scriptc: invalid record own-key plan\".into()); }} keys.push(key); index += 1.0; }}").unwrap();
        for field in &record.fields {
            let optional = field.r#type == Type::Undefined
                || matches!(&field.r#type, Type::Union { union_id } if module.unions[*union_id].arms.contains(&Type::Undefined));
            if !optional {
                writeln!(out, "if !keys.iter().any(|key| key == {:?}) {{ runtime::throw_type_error(\"scriptc: missing required record own key\".into()); }}", field.name).unwrap();
            }
        }
        let fields = record.fields.iter().map(|f| {
            let name = field_name(&f.name);
            let read = format!("source.with(|object| object.{name}.as_ref().expect(\"scriptc: cleared record\").clone())");
            let optional = f.r#type == Type::Undefined || matches!(&f.r#type, Type::Union { union_id } if module.unions[*union_id].arms.contains(&Type::Undefined));
            let value = if optional { format!("if keys.iter().any(|key| key == {:?}) {{ {read} }} else {{ {} }}", f.name, values::checked_value(&f.r#type, "NativeValue::Undefined", module)) } else { read };
            format!("{name}: Some({value})")
        }).collect::<Vec<_>>().join(",");
        writeln!(
            out,
            "runtime::Gc::new(R{id} {{ {fields}{} own_keys: keys }}) }}",
            if fields.is_empty() { "" } else { "," }
        )
        .unwrap();
    }
}
