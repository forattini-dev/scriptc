import type { RustDynamicContext } from "./dynamic.js";
import type { RustClosureShape } from "./model.js";

/** Emits checked-dynamic inspection and Node-compatible assertion messages. */
export function emitRustDynamicAssertions(
  context: RustDynamicContext,
  boxedShapes: readonly RustClosureShape[],
): void {
  const name = context.dynTypeName();
  const functionPatterns = boxedShapes
    .map((shape) => `${name}::${context.dynFunctionVariant(shape)}(..)`)
    .join(" | ");

  context.line("fn sc_dyn_assert_key(key: &runtime::JsString) -> String {");
  context.pushIndent();
  context.line("if key.as_ref() == \"__proto__\" { return \"['__proto__']\".to_owned(); }");
  context.line("let bytes = key.as_bytes();");
  context.line("let bare = !bytes.is_empty() && bytes.iter().enumerate().all(|(index, byte)| byte.is_ascii_alphabetic() || *byte == b'_' || (index > 0 && byte.is_ascii_digit()));");
  context.line("if bare { key.to_string() } else { runtime::assert_inspect_string(key) }");
  context.popIndent();
  context.line("}");

  context.line(`fn sc_dyn_assert_inspect(value: &${name}, indent: usize) -> String {`);
  context.pushIndent();
  context.line("match value {");
  context.pushIndent();
  context.line(`${name}::Undefined => "undefined".to_owned(),`);
  context.line(`${name}::Null => "null".to_owned(),`);
  context.line(`${name}::Number(value) => runtime::display_number(*value),`);
  context.line(`${name}::Boolean(value) => value.to_string(),`);
  context.line(`${name}::String(value) => runtime::assert_inspect_string(value),`);
  context.line(`${name}::Bytes(value) => {`);
  context.pushIndent();
  context.line("let length = runtime::bytes_len(value) as usize;");
  context.line("if length == 0 { return \"Uint8Array(0) []\".to_owned(); }");
  context.line("let mut output = format!(\"Uint8Array({length}) [\");");
  context.line("for index in 0..length { output.push('\\n'); output.push_str(&\" \".repeat(indent + 2)); output.push_str(&runtime::display_number(runtime::bytes_get(value, index as f64))); if index + 1 < length { output.push(','); } }");
  context.line("output.push('\\n'); output.push_str(&\" \".repeat(indent)); output.push(']'); output");
  context.popIndent();
  context.line("},");
  context.line(`${name}::Array(value) => {`);
  context.pushIndent();
  context.line("let length = runtime::array_len(value) as usize;");
  context.line("if length == 0 { return \"[]\".to_owned(); }");
  context.line("let mut output = \"[\".to_owned();");
  context.line("for index in 0..length { output.push('\\n'); output.push_str(&\" \".repeat(indent + 2)); output.push_str(&sc_dyn_assert_inspect(&runtime::array_get(value, index as f64), indent + 2)); if index + 1 < length { output.push(','); } }");
  context.line("output.push('\\n'); output.push_str(&\" \".repeat(indent)); output.push(']'); output");
  context.popIndent();
  context.line("},");
  context.line(`${name}::Object(value) => {`);
  context.pushIndent();
  context.line("if runtime::map_size(value) == 0.0 { return \"{}\".to_owned(); }");
  context.line("let mut entries = Vec::new(); let mut index = 0.0;");
  context.line("while index < runtime::map_iter_count(value) { if runtime::map_iter_live(value, index) { let key = runtime::map_iter_key(value, index); let field = runtime::map_iter_value(value, index); entries.push(format!(\"{}: {}\", sc_dyn_assert_key(&key), sc_dyn_assert_inspect(&field, indent + 2))); } index += 1.0; }");
  context.line("entries.sort(); let mut output = \"{\".to_owned(); let length = entries.len();");
  context.line("for (index, entry) in entries.into_iter().enumerate() { output.push('\\n'); output.push_str(&\" \".repeat(indent + 2)); output.push_str(&entry); if index + 1 < length { output.push(','); } }");
  context.line("output.push('\\n'); output.push_str(&\" \".repeat(indent)); output.push('}'); output");
  context.popIndent();
  context.line("},");
  for (const shape of boxedShapes) {
    context.line(`${name}::${context.dynFunctionVariant(shape)}(_, function_name, _) => if function_name.is_empty() { "[Function (anonymous)]".to_owned() } else { format!("[Function: {function_name}]") },`);
  }
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");

  context.line(`fn sc_dyn_assert_is_object(value: &${name}) -> bool { matches!(value, ${name}::Bytes(..) | ${name}::Array(..) | ${name}::Object(..)) }`);
  if (functionPatterns.length === 0) {
    context.line(`fn sc_dyn_assert_is_function(value: &${name}) -> bool { let _ = value; false }`);
  } else {
    context.line(`fn sc_dyn_assert_is_function(value: &${name}) -> bool { matches!(value, ${functionPatterns}) }`);
  }
  context.line(`fn sc_dyn_assert_message(actual: &${name}, expected: &${name}, negated: bool, deep: bool, message: &runtime::JsString, has_message: bool) {`);
  context.pushIndent();
  context.line("let equal = sc_dyn_equal(actual, expected, deep);");
  context.line("if (negated && !equal) || (!negated && equal) { return; }");
  context.line("let actual_text = sc_dyn_assert_inspect(actual, 0); let expected_text = sc_dyn_assert_inspect(expected, 0);");
  context.line(`let both_zero = matches!((actual, expected), (${name}::Number(left), ${name}::Number(right)) if *left == 0.0 && *right == 0.0);`);
  context.line(`runtime::assert_dyn_message(equal, &actual_text, &expected_text, sc_dyn_assert_is_object(actual), sc_dyn_assert_is_object(expected), sc_dyn_assert_is_function(actual), sc_dyn_assert_is_function(expected), matches!(actual, ${name}::String(..)), matches!(expected, ${name}::String(..)), both_zero, negated, deep, message, has_message);`);
  context.popIndent();
  context.line("}");
}
