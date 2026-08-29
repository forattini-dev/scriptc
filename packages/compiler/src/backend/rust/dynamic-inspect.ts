import type { RustDynamicContext } from "./dynamic-context.js";
import type { RustClosureShape } from "./model.js";

/** Emit util.inspect-compatible rendering for checked-dynamic values. */
export function emitRustDynamicInspect(
  context: RustDynamicContext,
  boxedShapes: readonly RustClosureShape[],
): void {
  const name = context.dynTypeName();
  const usesEmbeddedModules = context.hasEmbeddedModules();
  context.line(`fn sc_dyn_inspect(value: &${name}, recurse: f64, depth: f64) -> runtime::JsString {`);
  context.pushIndent();
  context.line("match value {");
  context.pushIndent();
  context.line(`${name}::Undefined => runtime::string("undefined"),`);
  context.line(`${name}::Null => runtime::string("null"),`);
  context.line(`${name}::Number(value) => runtime::inspect_number(*value),`);
  context.line(`${name}::Boolean(value) => runtime::string(&runtime::display_bool(*value)),`);
  context.line(`${name}::String(value) => runtime::inspect_string(value),`);
  context.line(`${name}::Regex(value) => runtime::string(&format!("/{}/{}", runtime::regex_source(value), runtime::regex_flags(value))),`);
  context.line(`${name}::Url(value) => runtime::url_href(value),`);
  emitTypedArrayInspect(context, `${name}::Bytes(value)`, "runtime::bytes_len(value)", "runtime::bytes_get(value, index)", '"Uint8Array"');
  emitTypedArrayInspect(context, `${name}::TypedBytes(value)`, "runtime::typed_bytes_len(value)", "runtime::typed_bytes_get(value, index)", "runtime::typed_bytes_name(value)");
  context.line(`${name}::Buffer(value) => runtime::inspect_buffer(value),`);
  context.line(`${name}::Promise(..) => runtime::string("Promise { <pending> }"),`);
  context.line(`${name}::Array(array) => {`);
  context.pushIndent();
  context.line("let length = runtime::array_len(array);");
  context.line("if length == 0.0 { return runtime::string(\"[]\"); }");
  context.line("if recurse > depth { return runtime::string(\"[Array]\"); }");
  context.line("runtime::inspect_begin(recurse + 1.0);");
  context.line("let shown = length.min(100.0);");
  context.line("let mut index = 0.0;");
  context.line("while index < shown {");
  context.pushIndent();
  context.line("let element = runtime::array_get(array, index);");
  context.line(`let is_number = matches!(&element, ${name}::Number(_));`);
  context.line("runtime::inspect_entry(&sc_dyn_inspect(&element, recurse + 1.0, depth), is_number);");
  context.line("index += 1.0;");
  context.popIndent();
  context.line("}");
  context.line("let more = length > 100.0;");
  context.line("if more {");
  context.pushIndent();
  context.line("let next = runtime::array_get(array, 100.0);");
  context.line(`runtime::inspect_entry(&runtime::inspect_more_items(length - 100.0), matches!(&next, ${name}::Number(_)));`);
  context.popIndent();
  context.line("}");
  context.line("runtime::inspect_end(&runtime::empty_string(), &runtime::string(\"[\"), &runtime::string(\"]\"), recurse + 1.0, true, more)");
  context.popIndent();
  context.line("},");
  context.line(`${name}::Object(object) => {`);
  context.pushIndent();
  context.line("let null_proto = sc_dyn_is_null_proto(object);");
  context.line("let keys = runtime::map_string_keys_js_order(object);");
  context.line("let length = runtime::array_len(&keys);");
  context.line("if length == 0.0 { return runtime::string(if null_proto { \"[Object: null prototype] {}\" } else { \"{}\" }); }");
  context.line("if recurse > depth { return runtime::string(if null_proto { \"[Object: null prototype]\" } else { \"[Object]\" }); }");
  context.line("runtime::inspect_begin(recurse + 1.0);");
  context.line("let mut index = 0.0;");
  context.line("while index < length {");
  context.pushIndent();
  context.line("let key = runtime::array_get(&keys, index);");
  context.line("let field = runtime::map_get_by(object, &key, |left, right| left.as_ref() == right.as_ref()).expect(\"scriptc: missing dynamic object field\");");
  context.line("let rendered = sc_dyn_inspect(&field, recurse + 1.0, depth);");
  context.line("let entry = runtime::string(&format!(\"{}: {}\", runtime::inspect_key(&key), rendered));");
  context.line("runtime::inspect_entry(&entry, false);");
  context.line("index += 1.0;");
  context.popIndent();
  context.line("}");
  context.line("let base = if null_proto { runtime::string(\"[Object: null prototype]\") } else { runtime::empty_string() }; runtime::inspect_end(&base, &runtime::string(\"{\"), &runtime::string(\"}\"), recurse + 1.0, false, false)");
  context.popIndent();
  context.line("},");
  context.line(`${name}::NetSocket(..) => runtime::string("Socket {}"),`);
  context.line(`${name}::NetServer(..) => runtime::string("Server {}"),`);
  context.line(`${name}::HttpRequest(..) => runtime::string("IncomingMessage {}"),`);
  context.line(`${name}::HttpResponse(..) => runtime::string("ServerResponse {}"),`);
  context.line(`${name}::HttpAgent(..) => runtime::string("Agent {}"),`);
  context.line(`${name}::NativeConstructor(name) => runtime::string(&format!("[Function: {name}]")),`);
  context.line(`${name}::NativeMethod(method) => runtime::string(&format!("[Function: {}]", method.name())),`);
  context.line(`${name}::Getter(value) => sc_dyn_inspect(value.as_ref(), recurse, depth),`);
  if (usesEmbeddedModules) context.line(`${name}::Island(value) => runtime::island_to_string(value),`);
  for (const shape of boxedShapes) {
    context.line(`${name}::${context.dynFunctionVariant(shape)}(_, function_name, _) => if function_name.is_empty() { runtime::string("[Function (anonymous)]") } else { runtime::string(&format!("[Function: {}]", function_name)) },`);
  }
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_inspect_s(value: &${name}, depth: f64) -> runtime::JsString {`);
  context.pushIndent();
  context.line(`match value { ${name}::String(text) => text.clone(), _ => sc_dyn_inspect(value, 0.0, depth), }`);
  context.popIndent();
  context.line("}");
}

function emitTypedArrayInspect(
  context: RustDynamicContext,
  pattern: string,
  length: string,
  get: string,
  typeName: string,
): void {
  context.line(`${pattern} => {`);
  context.pushIndent();
  context.line(`let length = ${length};`);
  context.line(`let type_name = ${typeName};`);
  context.line("if length == 0.0 { return runtime::string(&format!(\"{type_name}(0) []\")); }");
  context.line("if recurse > depth { return runtime::string(&format!(\"[{type_name}]\")); }");
  context.line("runtime::inspect_begin(recurse + 1.0);");
  context.line("let shown = length.min(100.0); let mut index = 0.0;");
  context.line(`while index < shown { runtime::inspect_entry(&runtime::inspect_number(${get}), true); index += 1.0; }`);
  context.line("let more = length > 100.0;");
  context.line("if more { runtime::inspect_entry(&runtime::inspect_more_items(length - 100.0), true); }");
  context.line("runtime::inspect_end(&runtime::empty_string(), &runtime::string(&format!(\"{type_name}({}) [\", length as usize)), &runtime::string(\"]\"), recurse + 1.0, true, more)");
  context.popIndent();
  context.line("},");
}
