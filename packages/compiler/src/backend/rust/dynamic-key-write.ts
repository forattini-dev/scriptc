import type { RustDynamicContext } from "./dynamic-context.js";

/** PutValue receives an already-evaluated key, not its string conversion.
 * Nullish bases fail without invoking key hooks. Plain map symbol writes
 * retain identity; unsupported coercion/exotic writes fail explicitly. */
export function emitRustDynamicKeyWrite(context: RustDynamicContext): void {
  const dyn = context.dynTypeName();
  const line = (value: string) => context.line(value);
  line(`fn sc_dyn_key_set_computed(value: &${dyn}, key: &${dyn}, field: ${dyn}) {`);
  line(`if matches!(value, ${dyn}::Null | ${dyn}::Undefined) {`);
  line(`match key { ${dyn}::Symbol(symbol) => sc_dyn_key_set_error(value, &runtime::symbol_to_string(symbol)),`);
  line(`${dyn}::Undefined | ${dyn}::Null | ${dyn}::Number(..) | ${dyn}::BigInt(..) | ${dyn}::Boolean(..) | ${dyn}::String(..) => sc_dyn_key_set_error(value, &sc_dyn_to_string(key)),`);
  line('_ => runtime::throw_type_error(format!("Cannot set properties of {}", sc_dyn_kind(value))), } }');
  line("match key {");
  line(`${dyn}::Symbol(symbol) => match value {`);
  line(`${dyn}::Object(object) => { if runtime::map_is_module_namespace(object) { runtime::throw_type_error(format!("Cannot add property {}, object is not extensible", runtime::symbol_to_string(symbol))); } runtime::map_symbol_set(object, symbol.clone(), field); },`);
  for (const key of context.dynBoxedFunctionShapes) {
    const shape = context.closureShapes.get(key);
    if (shape) line(`${dyn}::${context.dynFunctionVariant(shape)}(_, _, properties) => runtime::map_symbol_set(properties, symbol.clone(), field),`);
  }
  line(`${dyn}::Number(..) | ${dyn}::Boolean(..) | ${dyn}::String(..) => sc_dyn_key_set_error(value, &runtime::symbol_to_string(symbol)),`);
  line('_ => runtime::throw_error("scriptc: native symbol-keyed assignment on this receiver is not supported yet".to_owned()), },');
  line(`${dyn}::Undefined | ${dyn}::Null | ${dyn}::Number(..) | ${dyn}::BigInt(..) | ${dyn}::Boolean(..) | ${dyn}::String(..) => sc_dyn_key_set(value, sc_dyn_to_string(key), field),`);
  line('_ => runtime::throw_error("scriptc: native object property-key coercion is not supported yet".to_owned()),');
  line("} }");
}
