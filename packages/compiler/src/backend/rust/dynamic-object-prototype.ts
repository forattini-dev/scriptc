import type { RustDynamicContext } from "./dynamic-context.js";

/** Ordinary object maps do not yet carry the built-in Object.prototype.
 * Refuse observations of its properties instead of inventing undefined.
 * Own properties and explicit prototype objects are resolved before here;
 * null-prototype chains and unrelated missing keys still return undefined. */
export function emitRustDynamicObjectPrototype(context: Pick<RustDynamicContext, "line" | "dynTypeName">): void {
  const dyn = context.dynTypeName();
  context.line(`fn sc_dyn_object_prototype_fallback(object: &runtime::JsMap<runtime::JsString, ${dyn}>, key: &runtime::JsString) -> ${dyn} {`);
  context.line('if !runtime::map_has_null_prototype(object) && matches!(key.to_utf8_lossy(), "constructor" | "__defineGetter__" | "__defineSetter__" | "hasOwnProperty" | "__lookupGetter__" | "__lookupSetter__" | "isPrototypeOf" | "propertyIsEnumerable" | "toString" | "valueOf" | "__proto__" | "toLocaleString") {');
  context.line('runtime::throw_error(format!("scriptc: reading inherited Object.prototype.{} on native objects is not supported yet", key));');
  context.line("}");
  context.line(`${dyn}::Undefined }`);
}
