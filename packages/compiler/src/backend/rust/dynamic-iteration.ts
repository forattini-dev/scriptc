import type { RustClosureShape } from "./model.js";

interface RustDynamicIterationContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  dynFunctionVariant(shape: RustClosureShape): string;
  dynTypeName(): string;
}

/** Emit checked-dynamic iterable helpers shared by spread and prototype calls. */
export function emitRustDynamicIteration(
  context: RustDynamicIterationContext,
  boxedShapes: readonly RustClosureShape[],
): void {
  const name = context.dynTypeName();
  context.line(`fn sc_dyn_iter_n(value: &${name}, count: usize) -> ${name} {`);
  context.pushIndent();
  context.line(`let output: runtime::JsArray<${name}> = runtime::array_new(Vec::new());`);
  context.line("match value {");
  context.pushIndent();
  context.line(`${name}::Array(array) => for index in 0..count { let index = index as f64; runtime::array_push(&output, if index < runtime::array_len(array) { runtime::array_get(array, index) } else { ${name}::Undefined }); },`);
  context.line(`${name}::String(text) => { let mut chars = text.chars(); for _ in 0..count { runtime::array_push(&output, chars.next().map_or(${name}::Undefined, |character| ${name}::String(runtime::string(&character.to_string())))); } },`);
  context.line(`${name}::Bytes(bytes) | ${name}::Buffer(bytes) => for index in 0..count { let index = index as f64; runtime::array_push(&output, if index < runtime::bytes_len(bytes) { ${name}::Number(runtime::bytes_get(bytes, index)) } else { ${name}::Undefined }); },`);
  context.line(`${name}::TypedBytes(bytes) => for index in 0..count { let index = index as f64; runtime::array_push(&output, if index < runtime::typed_bytes_len(bytes) { ${name}::Number(runtime::typed_bytes_get(bytes, index)) } else { ${name}::Undefined }); },`);
  context.line("other => {");
  context.pushIndent();
  context.line("let description = match other {");
  context.pushIndent();
  context.line(`${name}::Undefined => "undefined".to_owned(),`);
  context.line(`${name}::Null => "object null".to_owned(),`);
  context.line(`${name}::Boolean(value) => format!("boolean {value}"),`);
  context.line(`${name}::Number(value) => format!("number {}", runtime::display_number(*value)),`);
  if (boxedShapes.length > 0) {
    context.line(`${boxedShapes.map((shape) => `${name}::${context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function".to_owned(),`);
  }
  context.line("_ => \"object\".to_owned(),");
  context.popIndent();
  context.line("};");
  context.line("runtime::throw_type_error(format!(\"{description} is not iterable (cannot read property Symbol(Symbol.iterator))\"));");
  context.popIndent();
  context.line("},");
  context.popIndent();
  context.line("}");
  context.line(`${name}::Array(output)`);
  context.popIndent();
  context.line("}");
}
