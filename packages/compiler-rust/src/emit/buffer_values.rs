//! Byte factory dispatch reads original owning arrays, tuples and data records.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    let mut used = false;
    module.visit_expressions(&mut |expr| {
        used |= matches!(expr, Expr::LibCall { r#fn, .. } if r#fn == "buffer.fromDyn");
    });
    if !used {
        return;
    }
    out.push_str(include_str!("../buffer_values_support.rs"));
    out.push_str("fn native_buffer_array_length(value: &NativeValue) -> Option<f64> { match value { NativeValue::Array(array) => Some(runtime::array_len(array)),\n");
    for (index, ty) in values::types(module).iter().enumerate() {
        match ty {
            Type::Array { elem } if **elem != Type::Dyn => {
                writeln!(
                    out,
                    "NativeValue::V{index}(array) => Some(runtime::array_len(array)),"
                )
                .unwrap();
            }
            Type::Record { shape_id } if module.records[*shape_id].tuple => {
                writeln!(
                    out,
                    "NativeValue::V{index}(_) => Some({}.0),",
                    module.records[*shape_id].fields.len()
                )
                .unwrap();
            }
            _ => {}
        }
    }
    out.push_str("_ => None, } }\nfn native_buffer_copy(value: &NativeValue) -> Option<runtime::JsBytes<u8>> { match value {\n");
    for (index, ty) in values::types(module).iter().enumerate() {
        if matches!(ty, Type::Bytes { .. }) {
            writeln!(
                out,
                "NativeValue::V{index}(bytes) => Some(runtime::buffer_from_bytes(bytes)),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => None, } }\nfn native_buffer_ordinary(value: &NativeValue) -> bool { match value { NativeValue::Object(_) | NativeValue::Record(..) => true,\n");
    for (index, ty) in values::types(module).iter().enumerate() {
        if let Type::Record { shape_id } = ty
            && !module.records[*shape_id].tuple
            && !record_storage::shared(&module.records[*shape_id])
        {
            writeln!(out, "NativeValue::V{index}(_) => true,").unwrap();
        }
    }
    out.push_str("_ => false, } }\n");
}
