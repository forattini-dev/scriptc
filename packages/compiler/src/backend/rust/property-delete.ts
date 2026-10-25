import type { RustDynamicContext } from "./dynamic-context.js";

export function emitNativeDeleteDefinitions(context: RustDynamicContext): void {
  const dyn = context.dynTypeName();
  context.line(`impl runtime::NativeDeleteValue for ${dyn} {
    fn delete_own_property(&self, key: &runtime::JsString) -> runtime::NativeDeleteResult {
      use runtime::NativeDeleteResult as D;
      match self {
        Self::Undefined | Self::Null => D::Nullish,
        Self::Object(object) => {
          if runtime::map_is_module_namespace(object) {
            return if runtime::map_has_by(object, key, |a,b| a == b) { D::NonConfigurable("[object Module]") } else { D::Deleted };
          }
          runtime::map_delete_by(object, key, |a,b| a == b);
          D::Deleted
        }
        Self::Array(array) => runtime::native_array_delete(array, key),
        Self::String(text) => runtime::native_string_delete(text, key),
        Self::Number(_) | Self::Boolean(_) | Self::BigInt(_) | Self::Symbol(_) => D::Deleted,
        _ => D::Unsupported("this specialized value"),
      }
    }
  }`);
}
