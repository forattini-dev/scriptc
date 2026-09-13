import type { RustLibCallContext } from "./lib-calls.js";
import type { RustExpressionContext } from "./expression-context.js";
import { arrayOf, BOOL, BYTES_U8, DATE_T, DYN, EFFECT_T, F64, STRING, type IrExpr } from "../../ir/ir.js";

type DynamicContext = Pick<RustLibCallContext, "dynTypeName" | "hasErrorClassRoots" | "errorValueName" | "rustType" | "emitDynFromValue">;

/** Effect channels are covariant: scalars, bytes and flat native arrays may
 * be consumed as unknown without having boxed a dynamic enum. Array views
 * retain identity and mutations. Other composites require a typed fallback.
 */
export function unboxEffectDynamic(context: DynamicContext, value: string, typedFallback = ""): string {
  const dyn = context.dynTypeName();
  const scalar = [["f64", "Number"], ["bool", "Boolean"], ["runtime::JsString", "String"], ["runtime::JsBigInt", "BigInt"], ["runtime::JsDate", "Date"], ["runtime::JsEffect", "Effect"]]
    .map(([type, variant]) => `if let Some(sc_value) = sc_boxed.downcast_ref::<${type}>() { return ${dyn}::${variant}(sc_value.clone()); }`)
    .join(" ");
  const references = [BYTES_U8, ...[F64, BOOL, STRING, DATE_T, EFFECT_T, DYN].map(arrayOf)]
    .map(type => `if let Some(sc_value) = sc_boxed.downcast_ref::<${context.rustType(type)}>() { return ${context.emitDynFromValue(type, "sc_value.clone()")}; }`)
    .join(" ");
  const error = context.hasErrorClassRoots()
    ? `if let Some(sc_value) = sc_boxed.downcast_ref::<${context.errorValueName()}>() { return sc_dyn_error_box(sc_value); }
       if let Some(sc_value) = sc_boxed.downcast_ref::<runtime::JsError>() { return sc_dyn_error_box(&${context.errorValueName()}::Builtin(sc_value.clone())); }`
    : "if let Some(sc_value) = sc_boxed.downcast_ref::<runtime::JsError>() { return sc_dyn_error_box(sc_value); }";
  return `(|sc_boxed: &runtime::EffectValue| -> ${dyn} {
    if let Some(sc_value) = sc_boxed.downcast_ref::<${dyn}>() { return sc_value.clone(); }
    ${scalar}
    ${references}
    if sc_boxed.downcast_ref::<runtime::EffectUnit>() == Some(&runtime::EffectUnit::Null) { return ${dyn}::Null; }
    if sc_boxed.downcast_ref::<runtime::EffectUnit>() == Some(&runtime::EffectUnit::Undefined) || sc_boxed.downcast_ref::<()>().is_some() { return ${dyn}::Undefined; }
    ${error}
    ${typedFallback}
    runtime::effect_unbox_mismatch("${dyn}")
  })(${value})`;
}

/** Squash may carry E, a defect of another type, or an interruption Error.
 * Keep the dynFrom carrier's existing composite conversion, but do not
 * force defects/interruptions through E's typed unbox first. */
export function emitEffectCauseDynamic(expr: Extract<IrExpr, { kind: "dynFrom" }>, context: RustExpressionContext, handle: string): string {
  const type = expr.value.type;
  const candidates = type.kind === "union" ? [type, ...context.union(type.unionId, expr.loc).arms] : [type];
  const seen = new Set<string>();
  const fallback = candidates.filter((arm) => !context.isUnit(arm)).flatMap((arm) => {
    const rust = context.rustType(arm, expr.loc);
    if (seen.has(rust)) return [];
    seen.add(rust);
    const converted = context.emitDynFromValue(arm, "sc_native.clone()", expr.loc);
    return [`if let Some(sc_native) = sc_boxed.downcast_ref::<${rust}>() { return ${converted}; }`];
  }).join(" ");
  return unboxEffectDynamic({
    dynTypeName: () => context.dynTypeName(),
    hasErrorClassRoots: () => context.errorClassRoots().length > 0,
    errorValueName: () => context.errorValueName(),
    rustType: (type, loc) => context.rustType(type, loc),
    emitDynFromValue: (type, value, loc) => context.emitDynFromValue(type, value, loc),
  }, `&runtime::effect_cause_squash(&${handle})`, fallback);
}
