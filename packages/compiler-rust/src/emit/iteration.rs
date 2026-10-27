//! Bounded standard iteration keeps the original owning element handles.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    let mut used = false;
    module.visit_expressions(&mut |value| used |= matches!(value, Expr::DynIterN { .. }));
    if !used {
        return;
    }
    out.push_str("fn native_iteration_length(value: &NativeValue) -> Option<usize> { match value { NativeValue::Array(array) => Some(runtime::array_len(array) as usize),\n");
    for (index, ty) in values::types(module).iter().enumerate() {
        let length = match ty {
            Type::Array { elem } if **elem != Type::Dyn => {
                "runtime::array_len(value) as usize".into()
            }
            Type::Bytes { .. } => "runtime::bytes_len(value) as usize".into(),
            Type::Record { shape_id } if module.records[*shape_id].tuple => {
                module.records[*shape_id].fields.len().to_string()
            }
            _ => continue,
        };
        writeln!(out, "NativeValue::V{index}(value) => Some({length}),").unwrap();
    }
    out.push_str("_ => None, } }\nfn native_iteration_item(value: &NativeValue, index: usize) -> NativeValue { match value {\n");
    for (index, ty) in values::types(module).iter().enumerate() {
        if matches!(ty, Type::Bytes { .. }) {
            writeln!(out, "NativeValue::V{index}(bytes) => NativeValue::Number(runtime::bytes_get(bytes, index as f64)),").unwrap();
        }
    }
    out.push_str(
        "_ => native_value_get(value.clone(), runtime::string(&index.to_string())), } }\n",
    );
    out.push_str(include_str!("../iteration_support.rs"));
}
