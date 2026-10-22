//! JSON uses the portable dynamic-value ABI and shared runtime traversal.
use super::*;
use std::fmt::Write;
pub(super) fn definitions(module: &Module, out: &mut String) {
    let mut used = false;
    module.visit_expressions(&mut |expr| {
        if let Expr::LibCall { r#fn, .. } = expr {
            used |= matches!(r#fn.as_str(), "json.stringifyNative" | "json.parseNative");
        }
    });
    if !used {
        return;
    }
    out.push_str(include_str!("../json_values_support.rs"));
    out.push_str("fn native_json_kind(value: &NativeValue) -> runtime::NativeJsonKind { use runtime::NativeJsonKind as K; match value { NativeValue::Undefined => K::Undefined, NativeValue::Null => K::Null, NativeValue::Boolean(v) => K::Boolean(*v), NativeValue::Number(v) => K::Number(*v), NativeValue::String(v) => K::String(runtime::string(v)), NativeValue::Symbol(_) => K::Symbol, NativeValue::Array(v) => K::Array { identity: v.identity(), length: runtime::array_len(v) as usize }, NativeValue::Object(v) => K::Object { identity: v.identity() }, NativeValue::Record(_,v) => K::Object { identity: v.identity() }, NativeValue::Map(v) => K::Object { identity: v.identity() }, NativeValue::Promise(v) => K::Object { identity: runtime::promise_view_identity(v) }, NativeValue::Regex(v) => K::Object { identity: std::rc::Rc::as_ptr(v) as usize },\n");
    for (index, ty) in values::types(module).iter().enumerate() {
        if let Type::Record { shape_id } = ty
            && module.records[*shape_id].tuple
        {
            writeln!(
                out,
                "NativeValue::V{index}(v) => K::Array {{ identity: v.identity(), length: {} }},",
                module.records[*shape_id].fields.len()
            )
            .unwrap();
            continue;
        }
        let kind = match ty {
            Type::Array { elem } if **elem != Type::Dyn => {
                Some("K::Array { identity: v.identity(), length: runtime::array_len(v) as usize }")
            }
            Type::Record { shape_id } if !record_storage::shared(&module.records[*shape_id]) => {
                Some("K::Object { identity: v.identity() }")
            }
            Type::Func { .. } | Type::Classval { .. } => Some("K::Function"),
            Type::Set { .. } => Some("K::Object { identity: v.identity() }"),
            Type::Map { key, value } if **key != Type::Dyn || **value != Type::Dyn => {
                Some("K::Object { identity: v.identity() }")
            }
            _ => None,
        };
        if let Some(kind) = kind {
            writeln!(out, "NativeValue::V{index}(v) => {kind},").unwrap();
        }
    }
    out.push_str("_ => K::Unsupported } }\nfn native_json_typed_keys(value: &NativeValue) -> Vec<String> { match value {\n");
    for (index, ty) in values::types(module).iter().enumerate() {
        if let Type::Record { shape_id } = ty
            && !record_storage::shared(&module.records[*shape_id])
        {
            writeln!(
                out,
                "NativeValue::V{index}(..) => native_value_own_keys(value),"
            )
            .unwrap();
        }
    }
    out.push_str("NativeValue::Promise(promise) => runtime::promise_own_keys(promise), _ => Vec::new() } }\n");
}
pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    let Expr::LibCall { r#fn, args, .. } = value else {
        return None;
    };
    let runtime = match r#fn.as_str() {
        "json.stringifyNative" => "native_json_stringify",
        "json.parseNative" => "native_json_parse",
        _ => return None,
    };
    Some(format!(
        "{{ let values = {}; runtime::{runtime}((0..runtime::array_len(&values) as usize).map(|index| runtime::array_get(&values, index as f64)).collect()) }}",
        expr(&args[0], function, module)
    ))
}
