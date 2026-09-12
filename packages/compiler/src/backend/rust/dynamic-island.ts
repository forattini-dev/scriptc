import type { IrExpr } from "../../ir/ir.js";
import type { RustDynamicContext } from "./dynamic-context.js";
import { emitIslandValue } from "./island-values.js";

/** Normalize primitive engine values at the unknown boundary. Objects and
 * functions retain their realm handle, identity and executable properties. */
export function emitRustDynamicIslandSupport(context: RustDynamicContext): void {
  if (!context.hasEmbeddedModules()) return;
  const name = context.dynTypeName();
  context.line(`fn sc_dyn_from_island(value: runtime::IslandValue) -> ${name} {`);
  context.pushIndent();
  context.line(`if runtime::island_is_undefined(&value) { return ${name}::Undefined; }`);
  context.line(`if runtime::island_is_null(&value) { return ${name}::Null; }`);
  context.line("match runtime::island_value_typeof(&value).to_utf8_lossy() {");
  context.pushIndent();
  context.line(`"number" => ${name}::Number(runtime::island_exit_number(&value)),`);
  context.line(`"boolean" => ${name}::Boolean(runtime::island_exit_boolean(&value)),`);
  // The current direct string exit uses UTF-8 replacement for lone
  // surrogates. JSON's scalar-string escaping preserves all UTF-16 units;
  // composite values never take this path.
  context.line(`"string" => runtime::json_parse_typed::<${name}>(&runtime::island_json(&value)),`);
  context.line(`_ => ${name}::Island(value),`);
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_normalize_island(value: ${name}) -> ${name} {`);
  context.pushIndent();
  context.line(`match value { ${name}::Island(value) => sc_dyn_from_island(value), value => value }`);
  context.popIndent();
  context.line("}");
  // The typed callback boundary copies JSON-compatible composites, like
  // hostArgument in island.ts. Unknown arguments keep their realm handles.
  context.line(`fn sc_dyn_typed_island_input(value: ${name}) -> ${name} {`);
  context.pushIndent();
  context.line("match sc_dyn_normalize_island(value) {");
  context.pushIndent();
  context.line(`${name}::Island(value) if !runtime::island_is_error(&value) && runtime::island_value_typeof(&value).as_ref() == "object" => runtime::json_parse_typed::<${name}>(&runtime::island_json(&value)),`);
  context.line("value => value,");
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_to_island(value: &${name}) -> runtime::IslandValue { ${emitIslandValue("value", context)} }`);
  context.line(`fn sc_dyn_call_with_receiver(callee: &${name}, receiver: &${name}, args: &[${name}], label: &str) -> ${name} {`);
  context.pushIndent();
  context.line(`if let ${name}::Island(callee) = callee {`);
  context.pushIndent();
  context.line("let receiver = sc_dyn_to_island(receiver);");
  context.line("let args = args.iter().map(sc_dyn_to_island).collect::<Vec<_>>();");
  context.line("return sc_dyn_from_island(runtime::island_call_this(callee, &receiver, &args));");
  context.popIndent();
  context.line("}");
  context.line("sc_dyn_call(callee, args, label)");
  context.popIndent();
  context.line("}");
  context.line("fn sc_dyn_island_has(value: &runtime::IslandValue, key: &runtime::JsString, own: bool) -> bool {");
  context.pushIndent();
  context.line('let global = runtime::island_global_get(if own { "Object" } else { "Reflect" });');
  context.line('runtime::island_exit_boolean(&runtime::island_call_method(&global, if own { "hasOwn" } else { "has" }, &[value.clone(), runtime::island_value_string(key)]))');
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_island_object_walk(value: &runtime::IslandValue, mode: u8) -> ${name} {`);
  context.pushIndent();
  context.line('let method = match mode { 0 => "keys", 1 => "values", _ => "entries" };');
  context.line('let items = runtime::island_call_method(&runtime::island_global_get("Object"), method, &[value.clone()]);');
  context.line('let length = runtime::island_exit_number(&runtime::island_get_property(&items, "length")) as usize;');
  context.line('let output = runtime::array_new(Vec::with_capacity(length));');
  context.line('for index in 0..length { runtime::array_push(&output, sc_dyn_from_island(runtime::island_get_index(&items, &runtime::island_value_number(index as f64)))); }');
  context.line(`${name}::Array(output)`);
  context.popIndent();
  context.line("}");
}

/** Engine-owned unknown objects must answer their own kind predicates. */
export function rustIslandDynamicTest(test: Extract<IrExpr, { kind: "dynTest" }>["test"], value: string): string {
  switch (test) {
    case "null": return `runtime::island_is_null(${value})`;
    case "undefined": return `runtime::island_is_undefined(${value})`;
    case "nullish": return `runtime::island_is_nullish(${value})`;
    case "truthy": return `runtime::island_truthy(${value})`;
    case "function": return `runtime::island_is_function(${value})`;
    case "error": return `runtime::island_is_error(${value})`;
    case "array": return `runtime::island_exit_boolean(&runtime::island_call_method(&runtime::island_global_get("Array"), "isArray", &[${value}.clone()]))`;
    case "bytes": return `runtime::island_exit_boolean(&runtime::island_call_method(&runtime::island_global_get("ArrayBuffer"), "isView", &[${value}.clone()]))`;
    case "integer": return `(runtime::island_value_typeof(${value}).as_ref() == "number" && runtime::number_is_integer(runtime::island_exit_number(${value})))`;
    case "number": case "string": case "boolean": case "object":
      return `runtime::island_value_typeof(${value}).as_ref() == "${test}"`;
  }
}
