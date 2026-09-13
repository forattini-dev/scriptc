import type { RustDynamicContext } from "./dynamic-context.js";

/** JSON visits original holders in order; only each callback result is wrapped.
 * This preserves identity, mutations and the runtime writer's cycle paths. */
export function emitRustDynamicJsonReplacer(context: RustDynamicContext): void {
  const name = context.dynTypeName();
  // The current JSON expression ABI returns String, so a Symbol root cannot
  // be represented faithfully. Nested Symbols still use null/omission.
  context.line(`fn sc_dyn_json_check_root(value: &${name}) { if matches!(value, ${name}::Symbol(..)) { runtime::throw_error("scriptc: JSON.stringify of a native Symbol root is not supported yet (requires an undefined result)".to_owned()); } }`);
  if (!context.usesDynamicInvoke()) return;
  context.line(`struct ScJsonReplacement { value: ${name}, replacer: ${name} }`);
  context.line(`fn sc_dyn_json_replace(holder: &${name}, key: &runtime::JsString, replacer: &${name}) -> ScJsonReplacement {`);
  context.pushIndent();
  context.line("let mut value = sc_dyn_key_get(holder, key, false);");
  context.line(`if matches!(&value, ${name}::Effect(..)) { return sc_dyn_effect_reflection("JSON.stringify toJSON preparation"); }`);
  context.line(`if matches!(&value, ${name}::Proxy(..)) { return sc_dyn_proxy_unsupported("JSON.stringify toJSON preparation"); }`);
  context.line(`if let ${name}::Date(date) = &value { value = if runtime::date_value_time(date).is_nan() { ${name}::Null } else { ${name}::String(runtime::date_value_inspect(date)) }; }`);
  context.line(`if matches!(&value, ${name}::Object(..)) {`);
  context.pushIndent();
  context.line('let hook = sc_dyn_key_get(&value, &runtime::string("toJSON"), false);');
  context.line('if sc_dyn_function_identity(&hook).is_some() {');
  context.line('let _this = sc_dyn_this_push(value.clone());');
  context.line(`value = sc_dyn_call(&hook, &[${name}::String(key.clone())], "toJSON");`);
  context.line('}');
  context.popIndent();
  context.line('}');
  context.line('let _this = sc_dyn_this_push(holder.clone());');
  context.line(`let value = sc_dyn_call(replacer, &[${name}::String(key.clone()), value], "JSON.stringify replacer");`);
  context.line('ScJsonReplacement { value, replacer: replacer.clone() }');
  context.popIndent();
  context.line('}');
  context.line('impl runtime::JsonValue for ScJsonReplacement {');
  context.pushIndent();
  context.line('fn is_json_undefined(&self) -> bool { runtime::JsonValue::is_json_undefined(&self.value) }');
  context.line('fn write_json(&self, writer: &mut runtime::JsonWriter) {');
  context.pushIndent();
  context.line('match &self.value {');
  context.line(`${name}::Object(object) => runtime::json_write_replaced_object(object, writer, |key| sc_dyn_json_replace(&self.value, key, &self.replacer)),`);
  context.line(`${name}::Array(array) => runtime::json_write_replaced_array(array, writer, |index| sc_dyn_json_replace(&self.value, &runtime::string(&index.to_string()), &self.replacer)),`);
  context.line('value => runtime::JsonValue::write_json(value, writer),');
  context.line('}');
  context.popIndent();
  context.line('}');
  context.popIndent();
  context.line('}');
  context.line(`fn sc_dyn_json_stringify_replacer(value: ${name}, replacer: ${name}, indent: &runtime::JsString) -> runtime::JsString {`);
  context.pushIndent();
  context.line('let root = runtime::map_new();');
  context.line('let key = runtime::empty_string();');
  context.line('runtime::map_set_by(&root, key.clone(), value, |left, right| left == right);');
  context.line(`let value = sc_dyn_json_replace(&${name}::Object(root), &key, &replacer);`);
  context.line('sc_dyn_json_check_root(&value.value);');
  context.line('runtime::json_stringify_indented(&value, indent.as_ref())');
  context.popIndent();
  context.line('}');
}
