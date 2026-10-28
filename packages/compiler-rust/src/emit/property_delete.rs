//! Owning storage implements the shared Rust deletion protocol.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    out.push_str(r#"
impl runtime::NativeDeleteValue for NativeValue {
    fn delete_own_property(&self, key: &runtime::JsString) -> runtime::NativeDeleteResult {
        use runtime::NativeDeleteResult as D;
        if let Some(properties) = native_function_properties(self) {
            native_function_data_key(key);
            properties.with_mut(|data| data.entries.retain(|(name, _)| name != key));
            return D::Deleted;
        }
        match self {
            Self::Undefined | Self::Null => D::Nullish,
            Self::Object(object) | Self::Record(_, object) => {
                object.with_mut(|data| data.entries.retain(|(name, _)| name != key));
                D::Deleted
            }
            Self::Array(array) => runtime::native_array_delete(array, key),
            Self::String(text) => runtime::native_string_delete(text, key),
            Self::Number(_) | Self::Boolean(_) | Self::BigInt(_) | Self::Symbol(_) => D::Deleted,
            Self::RawJson(_) => if *key == "rawJSON" { D::NonConfigurable("[object Object]") } else { D::Deleted },
"#);
    for (index, ty) in values::types(module).iter().enumerate() {
        // Typed reads must be able to observe a hole as undefined. Other
        // element layouts remain refused until their reads have that ABI.
        if matches!(ty, Type::Array { elem } if matches!(&**elem, Type::Union { union_id } if {
            let arms = &module.unions[*union_id].arms;
            arms.contains(&Type::Undefined)
                && arms.iter().all(|arm| matches!(arm, Type::F64 | Type::Bool | Type::String | Type::Undefined | Type::Null))
        })) {
            writeln!(
                out,
                "Self::V{index}(array) => runtime::native_array_delete(array, key),"
            )
            .unwrap();
        }
        if let Type::Record { shape_id } = ty
            && module.records[*shape_id].index_value.is_some()
            && !record_storage::shared(&module.records[*shape_id])
        {
            writeln!(out, "Self::V{index}(object) => {{ object.with_mut(|data| data.overflow.retain(|(name, _)| name != key)); D::Deleted }},").unwrap();
        }
    }
    out.push_str("_ => D::Unsupported(\"this specialized value\"),\n} } }\n");
}
