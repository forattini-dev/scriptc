import type { RustDynamicContext } from "./dynamic-context.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitNativeJsonDefinitions(context: RustDynamicContext): void {
  if (!context.usesDynamicInvoke()) return;
  const dyn = context.dynTypeName();
  context.line(`impl runtime::NativeJsonValue for ${dyn} {
    fn json_kind(&self) -> runtime::NativeJsonKind {
      use runtime::NativeJsonKind as K;
      match self {
        Self::Undefined => K::Undefined, Self::Null => K::Null, Self::Boolean(v) => K::Boolean(*v),
        Self::Number(v) => K::Number(*v), Self::String(v) => K::String(v.clone()), Self::Symbol(_) => K::Symbol,
        Self::BigInt(_) => K::BigInt,
        Self::Array(v) => K::Array { identity: v.identity(), length: runtime::array_len(v) as usize },
        Self::Object(v) => K::Object { identity: v.identity() }, Self::Map(v) => K::Object { identity: v.identity() }, Self::Set(v) => K::Object { identity: v.identity() },
        Self::Regex(v) => K::Object { identity: std::rc::Rc::as_ptr(v) as usize },
        Self::Promise(v) => K::Object { identity: runtime::promise_handle_identity(v) },
        _ if sc_dyn_typeof(self).as_ref() == "function" => K::Function, _ => K::Unsupported,
      }
    }
    fn json_undefined() -> Self { Self::Undefined }
    fn json_from_node(node: runtime::JsonNode) -> Self { <Self as runtime::JsonDecode>::decode_json(&node, "$").unwrap_or_else(|message| runtime::throw_type_error(message)) }
    fn json_root(value: Self) -> Self { let root = runtime::map_new(); runtime::map_set_by(&root, runtime::empty_string(), value, |a,b| a == b); Self::Object(root) }
    fn json_get(&self, key: &runtime::JsString) -> Self { sc_dyn_key_get(self, key, false) }
    fn json_define(&self, key: &runtime::JsString, value: Self) {
      match self {
        Self::Object(object) => { runtime::map_set_by(object, key.clone(), value, |a,b| a == b); },
        Self::Array(array) => runtime::array_set(array, key.parse::<f64>().expect("JSON array index"), value),
        _ => runtime::throw_type_error("scriptc: JSON reviver property creation requires a native data object".into()),
      }
    }
    fn json_delete(&self, key: &runtime::JsString) {
      match self {
        Self::Object(object) => { runtime::map_delete_by(object, key, |a,b| a == b); },
        Self::Array(array) => { runtime::array_delete(array, key.parse::<f64>().expect("JSON array index")); },
        _ => runtime::throw_type_error("scriptc: JSON reviver property deletion requires a native data object".into()),
      }
    }
    fn json_keys(&self) -> Vec<runtime::JsString> {
      match self {
        Self::Object(value) => { let keys = runtime::map_string_keys_js_order(value); (0..runtime::array_len(&keys) as usize).map(|index| runtime::array_get(&keys, index as f64)).collect() },
        Self::Promise(value) => runtime::promise_handle_own_keys(value).into_iter().map(runtime::JsString::from).collect(),
        _ => Vec::new(),
      }
    }
    fn json_call(&self, holder: &Self, args: &[Self]) -> Self { let _this = sc_dyn_this_push(holder.clone()); sc_dyn_call(self, args, "JSON callback") }
    fn json_primitive_string(&self) -> runtime::JsString { sc_dyn_string_coerce_js(self) }
  }`);
}
export function emitNativeJsonCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  const operation = expr.fn === "json.stringifyNative" ? "native_json_stringify" : expr.fn === "json.parseNative" ? "native_json_parse" : null;
  if (operation === null) return null;
  const values = context.nextTemporary();
  return `{ let ${values} = ${context.emitExpr(expr.args[0]!)}; runtime::${operation}((0..runtime::array_len(&${values}) as usize).map(|index| runtime::array_get(&${values}, index as f64)).collect()) }`;
}
