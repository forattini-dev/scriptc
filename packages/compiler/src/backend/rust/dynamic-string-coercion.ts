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
  context.line(`fn sc_dyn_primitive_coerce_hook(receiver: &${name}, method: &${name}, method_name: &str) -> Option<${name}> {`);
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
  context.line(`match &result { ${name}::Undefined | ${name}::Null | ${name}::Number(..) | ${name}::Boolean(..) | ${name}::String(..) => Some(result), _ => None, }`);
  context.popIndent();
  context.line("}");
  context.line("std::thread_local! { static SC_DYN_ARRAY_STRING_STACK: std::cell::RefCell<Vec<usize>> = const { std::cell::RefCell::new(Vec::new()) }; }");
  context.line("struct ScDynArrayStringGuard;");
  context.line("impl Drop for ScDynArrayStringGuard { fn drop(&mut self) { SC_DYN_ARRAY_STRING_STACK.with(|stack| { stack.borrow_mut().pop(); }); } }");
  context.line(`fn sc_dyn_array_string_coerce_js(array: &runtime::JsArray<${name}>) -> runtime::JsString {`);
  context.pushIndent();
  context.line("let identity = runtime::array_identity(array);");
  context.line("if SC_DYN_ARRAY_STRING_STACK.with(|stack| stack.borrow().contains(&identity)) { return runtime::empty_string(); }");
  context.line("SC_DYN_ARRAY_STRING_STACK.with(|stack| stack.borrow_mut().push(identity));");
  context.line("let _guard = ScDynArrayStringGuard;");
  context.line("let length = runtime::array_len(array) as usize;");
  context.line("let mut output = runtime::JsStringBuilder::new();");
  context.line("for index in 0..length {");
  context.pushIndent();
  context.line("if index > 0 { output.push(','); }");
  context.line(`let element = if (index as f64) < runtime::array_len(array) { runtime::array_get(array, index as f64) } else { ${name}::Undefined };`);
  context.line(`if !matches!(&element, ${name}::Undefined | ${name}::Null) { output.push_str(sc_dyn_string_coerce_js(&element).as_ref()); }`);
  context.popIndent();
  context.line("}");
  context.line("runtime::string(&output)");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_string_coerce_js(value: &${name}) -> runtime::JsString {`);
  context.pushIndent();
  context.line(`if let ${name}::Array(array) = value { return sc_dyn_array_string_coerce_js(array); }`);
  context.line(`let ${name}::Object(object) = value else { return sc_dyn_to_string(value); };`);
  context.line(`if let Some(to_string) = runtime::map_get_by(object, &runtime::string("toString"), |left, right| left.as_ref() == right.as_ref()) { if let Some(result) = sc_dyn_primitive_coerce_hook(value, &to_string, "toString") { return sc_dyn_to_string(&result); } } else if !sc_dyn_is_null_proto(object) { return runtime::string("[object Object]"); }`);
  context.line("if let Some(value_of) = runtime::map_get_by(object, &runtime::string(\"valueOf\"), |left, right| left.as_ref() == right.as_ref()) { if let Some(result) = sc_dyn_primitive_coerce_hook(value, &value_of, \"valueOf\") { return sc_dyn_to_string(&result); } }");
  context.line("runtime::throw_type_error(\"Cannot convert object to primitive value\".to_owned())");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_number_primitive(value: &${name}) -> ${name} {`);
  context.pushIndent();
  context.line(`if let ${name}::Array(array) = value { return ${name}::String(sc_dyn_array_string_coerce_js(array)); }`);
  context.line(`let ${name}::Object(object) = value else { return match value { ${name}::Undefined | ${name}::Null | ${name}::Number(..) | ${name}::Boolean(..) | ${name}::String(..) => value.clone(), _ => ${name}::String(sc_dyn_to_string(value)), }; };`);
  context.line(`for method_name in ["valueOf", "toString"] {`);
  context.pushIndent();
  context.line(`if let Some(method) = runtime::map_get_by(object, &runtime::string(method_name), |left, right| left.as_ref() == right.as_ref()) {`);
  context.pushIndent();
  context.line(`if let Some(result) = sc_dyn_primitive_coerce_hook(value, &method, method_name) { return result; }`);
  context.popIndent();
  context.line(`} else if method_name == "toString" && !sc_dyn_is_null_proto(object) { return ${name}::String(runtime::string("[object Object]")); }`);
  context.popIndent();
  context.line("}");
  context.line("runtime::throw_type_error(\"Cannot convert object to primitive value\".to_owned())");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_number_coerce_js(value: &${name}) -> f64 { sc_dyn_to_number(&sc_dyn_number_primitive(value)) }`);
  context.line(`fn sc_dyn_compare(left: &${name}, right: &${name}) -> f64 {`);
  context.pushIndent();
  context.line("let left = sc_dyn_number_primitive(left);");
  context.line("let right = sc_dyn_number_primitive(right);");
  context.line(`let order = match (&left, &right) { (${name}::String(left), ${name}::String(right)) => Some(left.encode_utf16().cmp(right.encode_utf16())), _ => sc_dyn_to_number(&left).partial_cmp(&sc_dyn_to_number(&right)), };`);
  context.line("match order { Some(std::cmp::Ordering::Less) => -1.0, Some(std::cmp::Ordering::Equal) => 0.0, Some(std::cmp::Ordering::Greater) => 1.0, None => f64::NAN, }");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_strict_equal(left: &${name}, right: &${name}) -> bool { match (left, right) { (${name}::Number(left), ${name}::Number(right)) => left == right, (${name}::Promise(left), ${name}::Promise(right)) => runtime::promise_handle_identity(left) == runtime::promise_handle_identity(right), _ => sc_dyn_equal(left, right, false), } }`);
}
