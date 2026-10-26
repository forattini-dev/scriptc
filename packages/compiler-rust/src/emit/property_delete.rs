//! Owning storage implements the shared Rust deletion protocol.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Module, out: &mut String) {
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
        if let Type::Record { shape_id } = ty
            && module.records[*shape_id].index_value.is_some()
        {
            writeln!(out, "Self::V{index}(object) => {{ object.with_mut(|data| data.overflow.retain(|(name, _)| name != key)); D::Deleted }},").unwrap();
        }
    }
    out.push_str("_ => D::Unsupported(\"this specialized value\"),\n} } }\n");
}
