import { emitRustDynamicIteration } from "./dynamic-iteration.js";
import type { RustDynamicContext } from "./dynamic-context.js";
import type { RustClosureShape } from "./model.js";

export function emitRustDynamicKindQueries(context: RustDynamicContext, boxedShapes: readonly RustClosureShape[]): void {
  const name = context.dynTypeName();
  const usesEmbeddedModules = context.hasEmbeddedModules();
  context.line(`fn sc_dyn_kind(value: &${name}) -> &'static str {`);
  context.pushIndent();
  context.line("match value {");
  context.pushIndent();
  context.line(`${name}::Undefined => "undefined",`);
  context.line(`${name}::Null => "null",`);
  context.line(`${name}::Number(..) => "number",`);
  context.line(`${name}::BigInt(..) => "bigint", ${name}::Date(..) => "object",`);
  context.line(`${name}::Boolean(..) => "boolean",`);
  context.line(`${name}::String(..) => "string",`);
  context.line(`${name}::Regex(..) => "object",`);
  context.line(`${name}::Url(..) => "object",`);
  context.line(`${name}::Bytes(..) => "bytes",`);
  context.line(`${name}::TypedBytes(..) => "bytes",`);
  context.line(`${name}::Buffer(..) => "bytes",`);
  context.line(`${name}::Array(..) => "array",`);
  context.line(`${name}::ArrayIterator(..) => "object",`);
  context.line(`${name}::Object(..) => "object",`);
  context.line(`${name}::Getter(..) => "function",`);
  context.line(`${name}::Promise(..) => "promise",`);
  context.line(`${name}::NetServer(..) => "object",`);
  context.line(`${name}::NetSocket(..) => "object",`);
  context.line(`${name}::AbortController(..) | ${name}::AbortSignal(..) | ${name}::HttpRequest(..) | ${name}::HttpHeaders(..) | ${name}::FetchBody(..) | ${name}::FetchReader(..) | ${name}::WebStream(..) | ${name}::WebController(..) | ${name}::WebReader(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => "object",`);
  if (boxedShapes.length > 0) {
    context.line(`${boxedShapes.map((shape) => `${name}::${context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
  }
  context.line(`${name}::NativeConstructor(..) | ${name}::NativeMethod(..) => "function",`);
  if (usesEmbeddedModules) context.line(`${name}::Island(..) => "object",`);
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  context.line(`fn sc_dyn_is_truthy(value: &${name}) -> bool {`);
  context.pushIndent();
  context.line("match value {");
  context.pushIndent();
  context.line(`${name}::Undefined | ${name}::Null => false,`);
  context.line(`${name}::Number(value) => *value != 0.0 && !value.is_nan(),`);
  context.line(`${name}::BigInt(value) => runtime::bigint_truthy(value),`);
  context.line(`${name}::Boolean(value) => *value,`);
  context.line(`${name}::String(value) => !value.is_empty(),`);
  context.line("_ => true,");
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  emitRustDynamicIteration(context, boxedShapes);
  context.line(`fn sc_dyn_typeof(value: &${name}) -> runtime::JsString {`);
  context.pushIndent();
  context.line("let kind = match value {");
  context.pushIndent();
  context.line(`${name}::Undefined => "undefined",`);
  context.line(`${name}::Number(..) => "number",`);
  context.line(`${name}::BigInt(..) => "bigint", ${name}::Date(..) => "object",`);
  context.line(`${name}::Boolean(..) => "boolean",`);
  context.line(`${name}::String(..) => "string",`);
  context.line(`${name}::Bytes(..) => "object",`);
  context.line(`${name}::TypedBytes(..) => "object",`);
  context.line(`${name}::Buffer(..) => "object",`);
  context.line(`${name}::NetServer(..) => "object",`);
  context.line(`${name}::NetSocket(..) => "object",`);
  if (boxedShapes.length > 0) {
    context.line(`${boxedShapes.map((shape) => `${name}::${context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
  }
  context.line(`${name}::NativeConstructor(..) | ${name}::NativeMethod(..) => "function",`);
  // A handle answers what the engine says: solid's accessors and
  // setters are functions there, and static code branches on that.
  if (usesEmbeddedModules) context.line(`${name}::Island(value) => return runtime::island_value_typeof(value),`);
  context.line("_ => \"object\",");
  context.popIndent();
  context.line("};");
  context.line("runtime::string(kind)");
  context.popIndent();
  context.line("}");
}
