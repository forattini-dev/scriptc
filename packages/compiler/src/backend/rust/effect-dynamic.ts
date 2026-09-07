import type { RustLibCallContext } from "./lib-calls.js";

/** Effect channels are covariant: a scalar producer may be consumed as
 * unknown without having boxed a dynamic enum. Keep already-dynamic values
 * and Error identities intact; never substitute an empty object on mismatch.
 */
export function unboxEffectDynamic(context: RustLibCallContext, value: string): string {
  const dyn = context.dynTypeName();
  const scalar = [["f64", "Number"], ["bool", "Boolean"], ["runtime::JsString", "String"]]
    .map(([type, variant]) => `if let Some(sc_value) = sc_boxed.downcast_ref::<${type}>() { return ${dyn}::${variant}(sc_value.clone()); }`)
    .join(" ");
  const error = context.hasErrorClassRoots()
    ? `if let Some(sc_value) = sc_boxed.downcast_ref::<${context.errorValueName()}>() { return sc_dyn_error_box(sc_value); }
       if let Some(sc_value) = sc_boxed.downcast_ref::<runtime::JsError>() { return sc_dyn_error_box(&${context.errorValueName()}::Builtin(sc_value.clone())); }`
    : "if let Some(sc_value) = sc_boxed.downcast_ref::<runtime::JsError>() { return sc_dyn_error_box(sc_value); }";
  return `(|sc_boxed: &runtime::EffectValue| -> ${dyn} {
    if let Some(sc_value) = sc_boxed.downcast_ref::<${dyn}>() { return sc_value.clone(); }
    ${scalar}
    if sc_boxed.downcast_ref::<runtime::EffectUnit>() == Some(&runtime::EffectUnit::Null) { return ${dyn}::Null; }
    if sc_boxed.downcast_ref::<runtime::EffectUnit>() == Some(&runtime::EffectUnit::Undefined) || sc_boxed.downcast_ref::<()>().is_some() { return ${dyn}::Undefined; }
    ${error}
    runtime::effect_unbox_mismatch("${dyn}")
  })(${value})`;
}
