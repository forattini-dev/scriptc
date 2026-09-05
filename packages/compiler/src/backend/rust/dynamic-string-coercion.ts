import type { RustClosureShape } from "./model.js";

/** The string-coercion hooks of the checked-dynamic value (`${obj}`,
 * String(obj), `+` over objects): a `toString`/`valueOf` member that is a
 * boxed closure runs with the receiver bound, the primitive answer
 * converts, anything else is Node's exact TypeError. Split from
 * dynamic.ts (the 1200-line ceiling). */
export interface RustDynamicStringCoercionContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  dynTypeName(): string;
  dynFunctionVariant(shape: RustClosureShape): string;
  usesDynamicInvoke(): boolean;
}

export function emitRustDynamicStringCoercion(
  context: RustDynamicStringCoercionContext,
  boxedShapes: readonly RustClosureShape[],
): void {
  const name = context.dynTypeName();
  const callable = boxedShapes
    .map((shape) => `${name}::${context.dynFunctionVariant(shape)}(..)`)
    .join(" | ");
  context.line(`fn sc_dyn_string_coerce_hook(receiver: &${name}, method: &${name}, method_name: &str) -> Option<runtime::JsString> {`);
  context.pushIndent();
  context.line("let result = match method {");
  context.pushIndent();
  if (callable.length > 0) {
    const thisBinding = context.usesDynamicInvoke()
      ? "let _this_guard = sc_dyn_this_push(receiver.clone());"
      : "let _ = receiver;";
    context.line(`${callable} => { ${thisBinding} sc_dyn_call(method, &[], method_name) },`);
  }
  context.line("_ => return None,");
  context.popIndent();
  context.line("};");
  context.line(`match &result { ${name}::Undefined | ${name}::Null | ${name}::Number(..) | ${name}::Boolean(..) | ${name}::String(..) => Some(sc_dyn_to_string(&result)), _ => None, }`);
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_string_coerce_js(value: &${name}) -> runtime::JsString {`);
  context.pushIndent();
  context.line(`let ${name}::Object(object) = value else { return sc_dyn_to_string(value); };`);
  context.line(`if let Some(to_string) = runtime::map_get_by(object, &runtime::string("toString"), |left, right| left.as_ref() == right.as_ref()) { if let Some(result) = sc_dyn_string_coerce_hook(value, &to_string, "toString") { return result; } } else if !sc_dyn_is_null_proto(object) { return runtime::string("[object Object]"); }`);
  context.line("if let Some(value_of) = runtime::map_get_by(object, &runtime::string(\"valueOf\"), |left, right| left.as_ref() == right.as_ref()) { if let Some(result) = sc_dyn_string_coerce_hook(value, &value_of, \"valueOf\") { return result; } }");
  context.line("runtime::throw_type_error(\"Cannot convert object to primitive value\".to_owned())");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_strict_equal(left: &${name}, right: &${name}) -> bool { match (left, right) { (${name}::Number(left), ${name}::Number(right)) => left == right, (${name}::Promise(left), ${name}::Promise(right)) => runtime::promise_handle_identity(left) == runtime::promise_handle_identity(right), _ => sc_dyn_equal(left, right, false), } }`);
}
