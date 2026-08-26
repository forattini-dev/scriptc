import type { IrModule, IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
import { mangleField } from "../mangle.js";
import { emitRustDynamicInvoke } from "./dynamic-invoke.js";
import { emitRustDynamicAssertions } from "./dynamic-assertions.js";
import type { IrFuncType, RustClassMeta, RustClosureShape } from "./model.js";

export interface RustDynamicContext {
  usesDyn(): boolean;
  usesDynamicInvoke(): boolean;
  readonly closureShapes: ReadonlyMap<string, RustClosureShape>;
  readonly dynAdapterShapes: ReadonlySet<string>;
  readonly dynBoxedFunctionShapes: ReadonlySet<string>;
  readonly records: ReadonlyMap<string, IrRecordShape>;
  readonly unions: ReadonlyMap<string, IrUnionDef>;
  module(): IrModule;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  dynFunctionCheckName(shape: RustClosureShape): string;
  dynFunctionVariant(shape: RustClosureShape): string;
  dynTypeName(): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  errorClassRoots(): RustClassMeta[];
  isEdgeValue(type: IrType): boolean;
  isRustJsonCompatible(type: IrType, visiting?: Set<string>): boolean;
  isUnit(type: IrType): boolean;
  needsClone(type: IrType): boolean;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustDynamicEmitter {
  constructor(private readonly context: RustDynamicContext) {}

  emitDynamicDefinition(): void {
    if (!this.context.usesDyn()) return;
    const name = this.context.dynTypeName();
    const boxedShapes = [...this.context.dynBoxedFunctionShapes].map((key) => {
      const shape = this.context.closureShapes.get(key);
      if (shape === undefined) this.context.unsupported(`dynamic function signature '${key}'`);
      return shape;
    });

    this.context.line("#[derive(Clone)]");
    this.context.line(`enum ${name} {`);
    this.context.pushIndent();
    this.context.line("Undefined,");
    this.context.line("Null,");
    this.context.line("Number(f64),");
    this.context.line("Boolean(bool),");
    this.context.line("String(runtime::JsString),");
    this.context.line("Bytes(runtime::JsBytes<u8>),");
    this.context.line(`Array(runtime::JsArray<${name}>),`);
    this.context.line(`Object(runtime::JsMap<runtime::JsString, ${name}>),`);
    for (const shape of boxedShapes) {
      this.context.line(`${this.context.dynFunctionVariant(shape)}(runtime::Gc<${this.context.closureName(shape)}>, runtime::JsString, runtime::JsMap<runtime::JsString, ${name}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::Trace for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    for (const shape of boxedShapes) {
      this.context.line(`Self::${this.context.dynFunctionVariant(shape)}(value, _, properties) => { tracer.edge(value); tracer.edge(properties); },`);
    }
    this.context.line("Self::Array(value) => tracer.edge(value),");
    this.context.line("Self::Object(value) => tracer.edge(value),");
    this.context.line("Self::Bytes(value) => tracer.edge(value),");
    this.context.line("_ => {},");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::HeapValue for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::ArrayElement for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::JsonValue for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn write_json(&self, writer: &mut runtime::JsonWriter) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined | ${name}::Null => writer.write_null(),`);
    this.context.line(`${name}::Number(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Boolean(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::String(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Bytes(value) => {`);
    this.context.pushIndent();
    this.context.line("writer.begin_object();");
    this.context.line("let mut first = true;");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::bytes_len(value) { writer.property(&mut first, &(index as usize).to_string(), &runtime::bytes_get(value, index)); index += 1.0; }");
    this.context.line("writer.end_object();");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Array(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Object(value) => runtime::JsonValue::write_json(value, writer),`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(..) => writer.write_null(),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn is_json_undefined(&self) -> bool {");
    this.context.pushIndent();
    const undefinedPatterns = [
      `${name}::Undefined`,
      ...boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`),
    ];
    this.context.line(`matches!(self, ${undefinedPatterns.join(" | ")})`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::JsonDecode for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn decode_json(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {");
    this.context.pushIndent();
    this.context.line("match node {");
    this.context.pushIndent();
    this.context.line("runtime::JsonNode::Null => Ok(Self::Null),");
    this.context.line("runtime::JsonNode::Bool(value) => Ok(Self::Boolean(*value)),");
    this.context.line("runtime::JsonNode::Number(value) => Ok(Self::Number(*value)),");
    this.context.line("runtime::JsonNode::String(value) => Ok(Self::String(value.clone())),");
    this.context.line("runtime::JsonNode::Array(elements) => {");
    this.context.pushIndent();
    this.context.line("let mut values = Vec::with_capacity(elements.len());");
    this.context.line("for (index, element) in elements.iter().enumerate() {");
    this.context.pushIndent();
    this.context.line("values.push(Self::decode_json(element, &runtime::json_index_path(path, index))?);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("Ok(Self::Array(runtime::array_new(values)))");
    this.context.popIndent();
    this.context.line("},");
    this.context.line("runtime::JsonNode::Object(fields) => {");
    this.context.pushIndent();
    this.context.line(`let object: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new();`);
    this.context.line("for (key, field) in fields {");
    this.context.pushIndent();
    this.context.line("let value = Self::decode_json(field, &runtime::json_property_path(path, key))?;");
    this.context.line("runtime::map_set_by(&object, runtime::string(key), value, |left, right| left.as_ref() == right.as_ref());");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("Ok(Self::Object(object))");
    this.context.popIndent();
    this.context.line("},");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_deep_copy(value: &${name}) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => ${name}::Undefined,`);
    this.context.line(`${name}::Null => ${name}::Null,`);
    this.context.line(`${name}::Number(value) => ${name}::Number(*value),`);
    this.context.line(`${name}::Boolean(value) => ${name}::Boolean(*value),`);
    this.context.line(`${name}::String(value) => ${name}::String(value.clone()),`);
    this.context.line(`${name}::Bytes(value) => ${name}::Bytes(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::Array(value) => {`);
    this.context.pushIndent();
    this.context.line(`let output: runtime::JsArray<${name}> = runtime::array_new(Vec::new());`);
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::array_len(value) {");
    this.context.pushIndent();
    this.context.line("let element = runtime::array_get(value, index);");
    this.context.line("runtime::array_push(&output, sc_dyn_deep_copy(&element));");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`${name}::Array(output)`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(value) => {`);
    this.context.pushIndent();
    this.context.line(`let output: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new();`);
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::map_iter_count(value) {");
    this.context.pushIndent();
    this.context.line("if runtime::map_iter_live(value, index) {");
    this.context.pushIndent();
    this.context.line("let key = runtime::map_iter_key(value, index);");
    this.context.line("let field = runtime::map_iter_value(value, index);");
    this.context.line("runtime::map_set_by(&output, key, sc_dyn_deep_copy(&field), |left, right| left.as_ref() == right.as_ref());");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`${name}::Object(output)`);
    this.context.popIndent();
    this.context.line("},");
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(value, function_name, properties) => ${name}::${this.context.dynFunctionVariant(shape)}(value.clone(), function_name.clone(), properties.clone()),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_to_json(value: &${name}, path: &str) -> Result<runtime::JsonNode, String> {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Null => Ok(runtime::JsonNode::Null),`);
    this.context.line(`${name}::Number(value) => Ok(runtime::JsonNode::Number(*value)),`);
    this.context.line(`${name}::Boolean(value) => Ok(runtime::JsonNode::Bool(*value)),`);
    this.context.line(`${name}::String(value) => Ok(runtime::JsonNode::String(value.clone())),`);
    this.context.line(`${name}::Bytes(..) => Err(format!("bytes at {path} is not JSON data")),`);
    this.context.line(`${name}::Array(value) => {`);
    this.context.pushIndent();
    this.context.line("let mut elements = Vec::new();");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::array_len(value) {");
    this.context.pushIndent();
    this.context.line("let element = runtime::array_get(value, index);");
    this.context.line("elements.push(sc_dyn_to_json(&element, &runtime::json_index_path(path, index as usize))?);");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("Ok(runtime::JsonNode::Array(elements))");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(value) => {`);
    this.context.pushIndent();
    this.context.line("let mut fields = Vec::new();");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::map_iter_count(value) {");
    this.context.pushIndent();
    this.context.line("if runtime::map_iter_live(value, index) {");
    this.context.pushIndent();
    this.context.line("let key = runtime::map_iter_key(value, index);");
    this.context.line("let field = runtime::map_iter_value(value, index);");
    this.context.line("let field_path = runtime::json_property_path(path, key.as_ref());");
    this.context.line("fields.push((key.to_string(), sc_dyn_to_json(&field, &field_path)?));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("Ok(runtime::JsonNode::Object(fields))");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Undefined => Err(format!("undefined at {path} is not JSON data")),`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(..) => Err(format!("function at {path} is not JSON data")),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");

    this.context.line(`fn sc_dyn_kind(value: &${name}) -> &'static str {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => "undefined",`);
    this.context.line(`${name}::Null => "null",`);
    this.context.line(`${name}::Number(..) => "number",`);
    this.context.line(`${name}::Boolean(..) => "boolean",`);
    this.context.line(`${name}::String(..) => "string",`);
    this.context.line(`${name}::Bytes(..) => "bytes",`);
    this.context.line(`${name}::Array(..) => "array",`);
    this.context.line(`${name}::Object(..) => "object",`);
    if (boxedShapes.length > 0) {
      this.context.line(`${boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_typeof(value: &${name}) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line("let kind = match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => "undefined",`);
    this.context.line(`${name}::Number(..) => "number",`);
    this.context.line(`${name}::Boolean(..) => "boolean",`);
    this.context.line(`${name}::String(..) => "string",`);
    this.context.line(`${name}::Bytes(..) => "object",`);
    if (boxedShapes.length > 0) {
      this.context.line(`${boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
    }
    this.context.line("_ => \"object\",");
    this.context.popIndent();
    this.context.line("};");
    this.context.line("runtime::string(kind)");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_dyn_key_index(key: &runtime::JsString) -> Option<usize> {");
    this.context.pushIndent();
    this.context.line("let bytes = key.as_bytes();");
    this.context.line("if bytes.is_empty() || (bytes.len() > 1 && bytes[0] == b'0') { return None; }");
    this.context.line("let mut index = 0usize;");
    this.context.line("for byte in bytes {");
    this.context.pushIndent();
    this.context.line("if !byte.is_ascii_digit() { return None; }");
    this.context.line("index = index.checked_mul(10)?.checked_add((byte - b'0') as usize)?;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("Some(index)");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_key_get(value: &${name}, key: &runtime::JsString, optional: bool) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined | ${name}::Null => {`);
    this.context.pushIndent();
    this.context.line(`if optional { return ${name}::Undefined; }`);
    this.context.line(`runtime::throw_type_error(format!("Cannot read properties of {} (reading '{}')", sc_dyn_kind(value), key))`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(object) => runtime::map_get_by(object, key, |left, right| left.as_ref() == right.as_ref()).unwrap_or(${name}::Undefined),`);
    this.context.line(`${name}::Array(array) => {`);
    this.context.pushIndent();
    this.context.line(`if key.as_ref() == "length" { ${name}::Number(runtime::array_len(array)) }`);
    this.context.line(`else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::array_len(array) as usize { runtime::array_get(array, index as f64) } else { ${name}::Undefined } }`);
    this.context.line(`else { ${name}::Undefined }`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::String(text) => {`);
    this.context.pushIndent();
    this.context.line(`if key.as_ref() == "length" { ${name}::Number(runtime::string_len(text)) }`);
    this.context.line(`else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::string_len(text) as usize { ${name}::String(runtime::string_char_at(text, index as f64)) } else { ${name}::Undefined } }`);
    this.context.line(`else { ${name}::Undefined }`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Bytes(bytes) => {`);
    this.context.pushIndent();
    this.context.line(`if key.as_ref() == "length" { ${name}::Number(runtime::bytes_len(bytes)) }`);
    this.context.line(`else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::bytes_len(bytes) as usize { ${name}::Number(runtime::bytes_get(bytes, index as f64)) } else { ${name}::Undefined } }`);
    this.context.line(`else { ${name}::Undefined }`);
    this.context.popIndent();
    this.context.line("},");
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(_, function_name, properties) => {`);
      this.context.pushIndent();
      this.context.line("if let Some(property) = runtime::map_get_by(properties, key, |left, right| left.as_ref() == right.as_ref()) { property }");
      this.context.line(`else if key.as_ref() == "name" { ${name}::String(function_name.clone()) }`);
      this.context.line(`else if key.as_ref() == "length" { ${name}::Number(${shape.type.params.length}.0) }`);
      this.context.line(`else { ${name}::Undefined }`);
      this.context.popIndent();
      this.context.line("},");
    }
    this.context.line(`_ => ${name}::Undefined,`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_key_set_error(value: &${name}, key: &runtime::JsString) -> ! {`);
    this.context.pushIndent();
    this.context.line(`if matches!(value, ${name}::Undefined | ${name}::Null) {`);
    this.context.pushIndent();
    this.context.line(`runtime::throw_type_error(format!("Cannot set properties of {} (setting '{}')", sc_dyn_kind(value), key));`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("let receiver = match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Number(number) => format!("number '{}'", runtime::display_number(*number)),`);
    this.context.line(`${name}::Boolean(boolean) => format!("boolean '{}'", runtime::display_bool(*boolean)),`);
    this.context.line(`${name}::String(text) => format!("string '{}'", text),`);
    this.context.line("_ => sc_dyn_kind(value).to_owned(),");
    this.context.popIndent();
    this.context.line("};");
    this.context.line(`runtime::throw_type_error(format!("Cannot create property '{}' on {}", key, receiver))`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_key_set(value: &${name}, key: runtime::JsString, field: ${name}) {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Object(object) => runtime::map_set_by(object, key, field, |left, right| left.as_ref() == right.as_ref()),`);
    this.context.line(`${name}::Array(array) => {`);
    this.context.pushIndent();
    this.context.line("let Some(index) = sc_dyn_key_index(&key) else { sc_dyn_key_set_error(value, &key); };");
    this.context.line(`while runtime::array_len(array) <= index as f64 { runtime::array_push(array, ${name}::Undefined); }`);
    this.context.line("runtime::array_set(array, index as f64, field);");
    this.context.popIndent();
    this.context.line("},");
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(_, _, properties) => runtime::map_set_by(properties, key, field, |left, right| left.as_ref() == right.as_ref()),`);
    }
    this.context.line("_ => sc_dyn_key_set_error(value, &key),");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_to_string(value: &${name}) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => runtime::string("undefined"),`);
    this.context.line(`${name}::Null => runtime::string("null"),`);
    this.context.line(`${name}::Number(value) => runtime::string(&runtime::display_number(*value)),`);
    this.context.line(`${name}::Boolean(value) => runtime::string(&runtime::display_bool(*value)),`);
    this.context.line(`${name}::String(value) => value.clone(),`);
    this.context.line(`${name}::Bytes(value) => runtime::bytes_join(value, &runtime::string(",")),`);
    this.context.line(`${name}::Array(value) => {`);
    this.context.pushIndent();
    this.context.line("let mut output = String::new();");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::array_len(value) {");
    this.context.pushIndent();
    this.context.line("if index > 0.0 { output.push(','); }");
    this.context.line("let element = runtime::array_get(value, index);");
    this.context.line(`if !matches!(&element, ${name}::Undefined | ${name}::Null) { output.push_str(sc_dyn_to_string(&element).as_ref()); }`);
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("runtime::string(&output)");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(object) => {`);
    this.context.pushIndent();
    this.context.line("if runtime::map_has_by(object, &runtime::string(\"%error\"), |left, right| left.as_ref() == right.as_ref()) {");
    this.context.pushIndent();
    this.context.line(`let error_name = match runtime::map_get_by(object, &runtime::string("name"), |left, right| left.as_ref() == right.as_ref()) { Some(${name}::String(value)) => value, _ => runtime::empty_string(), };`);
    this.context.line(`let message = match runtime::map_get_by(object, &runtime::string("message"), |left, right| left.as_ref() == right.as_ref()) { Some(${name}::String(value)) => value, _ => runtime::empty_string(), };`);
    this.context.line("if error_name.is_empty() { message } else if message.is_empty() { error_name } else { runtime::string(&format!(\"{error_name}: {message}\")) }");
    this.context.popIndent();
    this.context.line("} else { runtime::string(\"[object Object]\") }");
    this.context.popIndent();
    this.context.line("},");
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(_, function_name, _) => if function_name.is_empty() { runtime::string("function () { [native code] }") } else { runtime::string(&format!("function {}() {{ [native code] }}", function_name)) },`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.emitDynamicInspectDefinition(boxedShapes);
    this.context.line(`fn sc_dyn_specific_type(value: &${name}) -> String {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => "undefined".to_owned(),`);
    this.context.line(`${name}::Null => "null".to_owned(),`);
    this.context.line(`${name}::Number(value) => format!("type number ({})", runtime::format_number(*value)),`);
    this.context.line(`${name}::Boolean(value) => format!("type boolean ({value})"),`);
    this.context.line(`${name}::String(value) => runtime::dynamic_specific_string(value),`);
    this.context.line(`${name}::Bytes(..) => "an instance of Uint8Array".to_owned(),`);
    this.context.line(`${name}::Array(..) => "an instance of Array".to_owned(),`);
    this.context.line(`${name}::Object(..) => "an instance of Object".to_owned(),`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(_, function_name, _) => format!("function {function_name}"),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_arg_type_fail(name: &str, expected: &str, value: &${name}) -> ! {`);
    this.context.pushIndent();
    this.context.line("runtime::throw_type_error_code(format!(\"The \\\"{name}\\\" argument must be {expected}. Received {}\", sc_dyn_specific_type(value)), \"ERR_INVALID_ARG_TYPE\")");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_function_identity(value: &${name}) -> Option<usize> {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(closure, _, _) => Some(sc_closure_identity_${shape.index}(closure)),`);
    }
    this.context.line("_ => None,");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_check_fail(expected: &str, value: &${name}) -> ! {`);
    this.context.pushIndent();
    this.context.line("runtime::throw_type_error(format!(\"expected {expected} at $, got {}\", sc_dyn_kind(value)))");
    this.context.popIndent();
    this.context.line("}");
    this.emitDynamicScalarCheck("number", "f64", "Number");
    this.emitDynamicScalarCheck("boolean", "bool", "Boolean");
    this.emitDynamicScalarCheck("string", "runtime::JsString", "String");

    for (const key of this.context.dynAdapterShapes) {
      const target = this.context.closureShapes.get(key);
      if (target === undefined) this.context.unsupported(`dynamic adapter signature '${key}'`);
      this.context.line(`fn ${this.context.dynFunctionCheckName(target)}(value: ${name}) -> runtime::Gc<${this.context.closureName(target)}> {`);
      this.context.pushIndent();
      this.context.line("match value {");
      this.context.pushIndent();
      if (this.context.dynBoxedFunctionShapes.has(key)) {
        this.context.line(`${name}::${this.context.dynFunctionVariant(target)}(closure, _, _) => closure,`);
      }
      const adaptable = boxedShapes.filter((shape) => typeKey(shape.type) !== key);
      if (adaptable.length > 0) {
        const patterns = adaptable.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ");
        this.context.line(`value @ (${patterns}) => runtime::Gc::new(${this.context.closureName(target)}::DynAdapter { value: Some(value) }),`);
      }
      this.context.line("value => sc_dyn_check_fail(\"function\", &value),");
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
    }

    this.context.line(`fn sc_dyn_call(callee: &${name}, args: &[${name}], callee_name: &str) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("match callee {");
    this.context.pushIndent();
    for (const shape of boxedShapes) {
      const typedArgs = shape.type.params.map((param, index) => {
        const value = `args.get(${index}).cloned().unwrap_or(${name}::Undefined)`;
        return this.emitDynCheckValue(param, value);
      });
      if (shape.type.rest === true) {
        if (shape.type.restAbi === "jsval") this.context.unsupported("dynamic jsval rest call");
        typedArgs.push(`${name}::Array(runtime::array_new(args.iter().skip(${shape.type.params.length}).cloned().collect()))`);
      }
      const loc = this.context.module().functions[0]?.loc;
      if (loc === undefined) this.context.unsupported("dynamic call without a source location");
      const dispatch = this.context.emitClosureDispatch("sc_dyn_callee", shape.type, typedArgs, loc);
      const result = this.emitDynFromResult(shape.type.ret, dispatch);
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(closure, _, _) => { let sc_dyn_callee = closure.clone(); ${result} },`);
    }
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    if (this.context.usesDynamicInvoke()) emitRustDynamicInvoke(this.context, boxedShapes);
    this.emitDynamicErrorAndCloneHelpers(boxedShapes);
    emitRustDynamicAssertions(this.context, boxedShapes);
    this.context.line("");
  }

  emitDynamicInspectDefinition(boxedShapes: readonly RustClosureShape[]): void {
    const name = this.context.dynTypeName();
    this.context.line(`fn sc_dyn_inspect(value: &${name}, recurse: f64, depth: f64) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => runtime::string("undefined"),`);
    this.context.line(`${name}::Null => runtime::string("null"),`);
    this.context.line(`${name}::Number(value) => runtime::inspect_number(*value),`);
    this.context.line(`${name}::Boolean(value) => runtime::string(&runtime::display_bool(*value)),`);
    this.context.line(`${name}::String(value) => runtime::inspect_string(value),`);
    this.context.line(`${name}::Bytes(value) => {`);
    this.context.pushIndent();
    this.context.line("let length = runtime::bytes_len(value);");
    this.context.line("if length == 0.0 { return runtime::string(\"Uint8Array(0) []\"); }");
    this.context.line("if recurse > depth { return runtime::string(\"[Uint8Array]\"); }");
    this.context.line("runtime::inspect_begin(recurse + 1.0);");
    this.context.line("let shown = length.min(100.0);");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < shown {");
    this.context.pushIndent();
    this.context.line("runtime::inspect_entry(&runtime::inspect_number(runtime::bytes_get(value, index)), true);");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("let more = length > 100.0;");
    this.context.line("if more { runtime::inspect_entry(&runtime::inspect_more_items(length - 100.0), true); }");
    this.context.line("runtime::inspect_end(&runtime::empty_string(), &runtime::string(&format!(\"Uint8Array({}) [\", length as usize)), &runtime::string(\"]\"), recurse + 1.0, true, more)");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Array(array) => {`);
    this.context.pushIndent();
    this.context.line("let length = runtime::array_len(array);");
    this.context.line("if length == 0.0 { return runtime::string(\"[]\"); }");
    this.context.line("if recurse > depth { return runtime::string(\"[Array]\"); }");
    this.context.line("runtime::inspect_begin(recurse + 1.0);");
    this.context.line("let shown = length.min(100.0);");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < shown {");
    this.context.pushIndent();
    this.context.line("let element = runtime::array_get(array, index);");
    this.context.line(`let is_number = matches!(&element, ${name}::Number(_));`);
    this.context.line("runtime::inspect_entry(&sc_dyn_inspect(&element, recurse + 1.0, depth), is_number);");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("let more = length > 100.0;");
    this.context.line("if more {");
    this.context.pushIndent();
    this.context.line("let next = runtime::array_get(array, 100.0);");
    this.context.line(`runtime::inspect_entry(&runtime::inspect_more_items(length - 100.0), matches!(&next, ${name}::Number(_)));`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("runtime::inspect_end(&runtime::empty_string(), &runtime::string(\"[\"), &runtime::string(\"]\"), recurse + 1.0, true, more)");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(object) => {`);
    this.context.pushIndent();
    this.context.line("let keys = runtime::map_string_keys_js_order(object);");
    this.context.line("let length = runtime::array_len(&keys);");
    this.context.line("if length == 0.0 { return runtime::string(\"{}\"); }");
    this.context.line("if recurse > depth { return runtime::string(\"[Object]\"); }");
    this.context.line("runtime::inspect_begin(recurse + 1.0);");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < length {");
    this.context.pushIndent();
    this.context.line("let key = runtime::array_get(&keys, index);");
    this.context.line("let field = runtime::map_get_by(object, &key, |left, right| left.as_ref() == right.as_ref()).expect(\"scriptc: missing dynamic object field\");");
    this.context.line("let rendered = sc_dyn_inspect(&field, recurse + 1.0, depth);");
    this.context.line("let entry = runtime::string(&format!(\"{}: {}\", runtime::inspect_key(&key), rendered));");
    this.context.line("runtime::inspect_entry(&entry, false);");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("runtime::inspect_end(&runtime::empty_string(), &runtime::string(\"{\"), &runtime::string(\"}\"), recurse + 1.0, false, false)");
    this.context.popIndent();
    this.context.line("},");
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(_, function_name, _) => if function_name.is_empty() { runtime::string("[Function (anonymous)]") } else { runtime::string(&format!("[Function: {}]", function_name)) },`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_inspect_s(value: &${name}, depth: f64) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line(`match value { ${name}::String(text) => text.clone(), _ => sc_dyn_inspect(value, 0.0, depth), }`);
    this.context.popIndent();
    this.context.line("}");
  }

  emitDynamicErrorAndCloneHelpers(boxedShapes: readonly RustClosureShape[]): void {
    const name = this.context.dynTypeName();
    const mapType = `runtime::JsMap<runtime::JsString, ${name}>`;

    this.context.line("std::thread_local! {");
    this.context.pushIndent();
    this.context.line(`static SC_DYN_ERROR_CACHE: std::cell::RefCell<Vec<(usize, runtime::JsError, ${mapType})>> = const { std::cell::RefCell::new(Vec::new()) };`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_error_box(error: &runtime::JsError) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("let identity = runtime::error_identity(error);");
    this.context.line("if let Some(object) = SC_DYN_ERROR_CACHE.with(|cache| cache.borrow().iter().find(|(cached, _, _)| *cached == identity).map(|(_, _, object)| object.clone())) {");
    this.context.pushIndent();
    this.context.line(`return ${name}::Object(object);`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`let object: ${mapType} = runtime::map_new();`);
    this.context.line("SC_DYN_ERROR_CACHE.with(|cache| cache.borrow_mut().push((identity, error.clone(), object.clone())));");
    this.context.line(`runtime::map_set_by(&object, runtime::string("%error"), ${name}::Boolean(true), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line(`runtime::map_set_by(&object, runtime::string("name"), ${name}::String(runtime::error_name(error)), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line(`runtime::map_set_by(&object, runtime::string("message"), ${name}::String(runtime::error_message(error)), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line("if runtime::error_is_class(error, \"DOMException\") {");
    this.context.pushIndent();
    this.context.line(`runtime::map_set_by(&object, runtime::string("code"), ${name}::Number(runtime::error_dom_code(error)), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line(`if let Some(cause) = runtime::error_dom_cause::<${name}>(error) { runtime::map_set_by(&object, runtime::string("cause"), cause, |left, right| left.as_ref() == right.as_ref()); }`);
    this.context.popIndent();
    this.context.line("} else if let Some(code) = runtime::error_code(error) {");
    this.context.pushIndent();
    this.context.line(`runtime::map_set_by(&object, runtime::string("code"), ${name}::String(code), |left, right| left.as_ref() == right.as_ref());`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`${name}::Object(object)`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_error_instanceof(value: &${name}, kind: f64) -> bool {`);
    this.context.pushIndent();
    this.context.line("let target = match kind as i32 { 0 => \"Error\", 1 => \"TypeError\", 2 => \"RangeError\", 3 => \"SyntaxError\", 4 => \"DOMException\", _ => return false };");
    this.context.line(`let ${name}::Object(object) = value else { return false; };`);
    this.context.line("let identity = object.identity();");
    this.context.line("SC_DYN_ERROR_CACHE.with(|cache| cache.borrow().iter().find(|(_, _, cached)| cached.identity() == identity).is_some_and(|(_, error, _)| runtime::error_is_class(error, target)))");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_dyn_error_cache_clear() {");
    this.context.pushIndent();
    this.context.line("SC_DYN_ERROR_CACHE.with(|cache| cache.borrow_mut().clear());");
    this.context.popIndent();
    this.context.line("}");

    this.context.line(`fn sc_dyn_validate_clone_options(options: &${name}) {`);
    this.context.pushIndent();
    this.context.line(`if matches!(options, ${name}::Undefined | ${name}::Null) { return; }`);
    this.context.line(`let ${name}::Object(object) = options else {`);
    this.context.pushIndent();
    this.context.line("runtime::throw_type_error_code(\"Failed to execute 'structuredClone': Options cannot be converted to a dictionary\".to_owned(), \"ERR_INVALID_ARG_TYPE\");");
    this.context.popIndent();
    this.context.line("};");
    this.context.line(`let transfer = runtime::map_get_by(object, &runtime::string("transfer"), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${name}::Undefined);`);
    this.context.line(`if matches!(transfer, ${name}::Undefined) { return; }`);
    this.context.line(`let ${name}::Array(transfer) = transfer else {`);
    this.context.pushIndent();
    this.context.line("runtime::throw_type_error_code(\"Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.\".to_owned(), \"ERR_INVALID_ARG_TYPE\");");
    this.context.popIndent();
    this.context.line("};");
    this.context.line("if runtime::array_len(&transfer) > 0.0 { runtime::throw_dom_exception(\"DataCloneError\", \"Found invalid value in transferList.\"); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_clone(value: &${name}, parents: &mut Vec<usize>) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => ${name}::Undefined,`);
    this.context.line(`${name}::Null => ${name}::Null,`);
    this.context.line(`${name}::Number(value) => ${name}::Number(*value),`);
    this.context.line(`${name}::Boolean(value) => ${name}::Boolean(*value),`);
    this.context.line(`${name}::String(value) => ${name}::String(value.clone()),`);
    this.context.line(`${name}::Bytes(value) => ${name}::Bytes(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::Array(value) => {`);
    this.context.pushIndent();
    this.context.line("let identity = value.identity();");
    this.context.line("if parents.contains(&identity) { runtime::throw_value(runtime::error_new(\"Error\", runtime::string(\"structuredClone of cyclic values (the checked-dynamic tree cannot represent cycles) is not supported yet\"))); }");
    this.context.line("parents.push(identity);");
    this.context.line(`let output: runtime::JsArray<${name}> = runtime::array_new(Vec::new());`);
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::array_len(value) { let field = runtime::array_get(value, index); runtime::array_push(&output, sc_dyn_clone(&field, parents)); index += 1.0; }");
    this.context.line("parents.pop();");
    this.context.line(`${name}::Array(output)`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(value) => {`);
    this.context.pushIndent();
    this.context.line("let identity = value.identity();");
    this.context.line("if parents.contains(&identity) { runtime::throw_value(runtime::error_new(\"Error\", runtime::string(\"structuredClone of cyclic values (the checked-dynamic tree cannot represent cycles) is not supported yet\"))); }");
    this.context.line("parents.push(identity);");
    this.context.line(`let output: ${mapType} = runtime::map_new();`);
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::map_iter_count(value) {");
    this.context.pushIndent();
    this.context.line("if runtime::map_iter_live(value, index) { let key = runtime::map_iter_key(value, index); let field = runtime::map_iter_value(value, index); runtime::map_set_by(&output, key, sc_dyn_clone(&field, parents), |left, right| left.as_ref() == right.as_ref()); }");
    this.context.line("index += 1.0;");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("parents.pop();");
    this.context.line(`${name}::Object(output)`);
    this.context.popIndent();
    this.context.line("},");
    if (boxedShapes.length > 0) {
      const patterns = boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ");
      this.context.line(`value @ (${patterns}) => runtime::throw_dom_exception("DataCloneError", &format!("{} could not be cloned.", sc_dyn_to_string(value))),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_structured_clone(value: &${name}, options: &${name}) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("sc_dyn_validate_clone_options(options);");
    this.context.line("sc_dyn_clone(value, &mut Vec::new())");
    this.context.popIndent();
    this.context.line("}");

    this.context.line(`fn sc_dyn_equal(left: &${name}, right: &${name}, deep: bool) -> bool {`);
    this.context.pushIndent();
    this.context.line("match (left, right) {");
    this.context.pushIndent();
    this.context.line(`(${name}::Undefined, ${name}::Undefined) | (${name}::Null, ${name}::Null) => true,`);
    this.context.line(`(${name}::Number(left), ${name}::Number(right)) => runtime::number_same_value(*left, *right),`);
    this.context.line(`(${name}::Boolean(left), ${name}::Boolean(right)) => left == right,`);
    this.context.line(`(${name}::String(left), ${name}::String(right)) => left.as_ref() == right.as_ref(),`);
    this.context.line(`(${name}::Bytes(left), ${name}::Bytes(right)) => {`);
    this.context.pushIndent();
    this.context.line("if left.ptr_eq(right) { true } else if !deep || runtime::bytes_len(left) != runtime::bytes_len(right) { false } else {");
    this.context.pushIndent();
    this.context.line("let mut index = 0.0; let mut equal = true; while equal && index < runtime::bytes_len(left) { equal = runtime::bytes_get(left, index) == runtime::bytes_get(right, index); index += 1.0; } equal");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`(${name}::Array(left), ${name}::Array(right)) => {`);
    this.context.pushIndent();
    this.context.line("if left.ptr_eq(right) { true } else if !deep || runtime::array_len(left) != runtime::array_len(right) { false } else {");
    this.context.pushIndent();
    this.context.line("let mut index = 0.0; let mut equal = true; while equal && index < runtime::array_len(left) { equal = sc_dyn_equal(&runtime::array_get(left, index), &runtime::array_get(right, index), true); index += 1.0; } equal");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`(${name}::Object(left), ${name}::Object(right)) => {`);
    this.context.pushIndent();
    this.context.line("if left.ptr_eq(right) { true } else if !deep || runtime::map_size(left) != runtime::map_size(right) { false } else {");
    this.context.pushIndent();
    this.context.line("let mut index = 0.0; let mut equal = true; while equal && index < runtime::map_iter_count(left) { if runtime::map_iter_live(left, index) { let key = runtime::map_iter_key(left, index); let field = runtime::map_iter_value(left, index); equal = runtime::map_get_by(right, &key, |a, b| a.as_ref() == b.as_ref()).is_some_and(|other| sc_dyn_equal(&field, &other, true)); } index += 1.0; } equal");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("},");
    for (const shape of boxedShapes) {
      const variant = this.context.dynFunctionVariant(shape);
      this.context.line(`(${name}::${variant}(left, _, _), ${name}::${variant}(right, _, _)) => left.identity() == right.identity(),`);
    }
    this.context.line("_ => false,");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  emitDynamicScalarCheck(expected: string, rustType: string, variant: string): void {
    const name = this.context.dynTypeName();
    this.context.line(`fn sc_dyn_check_${expected}(value: ${name}) -> ${rustType} {`);
    this.context.pushIndent();
    this.context.line(`match value { ${name}::${variant}(value) => value, value => sc_dyn_check_fail("${expected}", &value) }`);
    this.context.popIndent();
    this.context.line("}");
  }

  emitDynFromResult(type: IrType, value: string, loc?: SrcLoc): string {
    if (type.kind === "void") return `{ let _ = ${value}; ${this.context.dynTypeName()}::Undefined }`;
    return this.emitDynFromValue(type, value, loc);
  }

  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName = ""): string {
    const name = this.context.dynTypeName();
    switch (type.kind) {
      case "dyn": return value;
      case "f64": return `${name}::Number(${value})`;
      case "bool": return `${name}::Boolean(${value})`;
      case "string": return `${name}::String(${value})`;
      case "bytes": {
        if (type.elem !== "u8") this.context.unsupported(`dynamic boxing from bytes<${type.elem}>`, loc);
        return `${name}::Bytes(runtime::bytes_copy(&(${value})))`;
      }
      case "undefinedT": return `{ let _ = ${value}; ${name}::Undefined }`;
      case "nullT": return `{ let _ = ${value}; ${name}::Null }`;
      case "func": {
        const shape = this.context.closureShapeForType(type, loc);
        if (!this.context.dynBoxedFunctionShapes.has(typeKey(type))) {
          this.context.unsupported(`dynamic function boxing for '${typeKey(type)}'`, loc);
        }
        if (this.context.usesDynamicInvoke()) {
          return `sc_dyn_box_function_${shape.index}(${value}, runtime::string("${this.context.rustString(functionName)}"))`;
        }
        return `${name}::${this.context.dynFunctionVariant(shape)}(${value}, runtime::string("${this.context.rustString(functionName)}"), runtime::map_new())`;
      }
      case "array": {
        const source = this.context.nextTemporary();
        const output = this.context.nextTemporary();
        const index = this.context.nextTemporary();
        const element = this.emitDynFromValue(
          type.elem,
          `runtime::array_get(&${source}, ${index})`,
          loc,
        );
        return `{ let ${source} = ${value}; let ${output}: runtime::JsArray<${name}> = runtime::array_new(Vec::new()); let mut ${index} = 0.0; while ${index} < runtime::array_len(&${source}) { runtime::array_push(&${output}, ${element}); ${index} += 1.0; } ${name}::Array(${output}) }`;
      }
      case "union": {
        const union = this.context.union(type.unionId, loc);
        const unionValue = this.context.nextTemporary();
        const arms = union.arms.map((arm, tag) => {
          const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(tag)}`;
          if (this.context.isUnit(arm)) {
            return `${variant} => ${this.emitDynFromValue(arm, "()", loc)}`;
          }
          return `${variant}(payload) => ${this.emitDynFromValue(arm, "payload", loc)}`;
        }).join(", ");
        return `{ let ${unionValue} = ${value}; match ${unionValue} { ${arms} } }`;
      }
      case "object": {
        if (!RUNTIME_ERROR_CLASSES.has(type.className)) {
          this.context.unsupported(`dynamic boxing from object '${type.className}'`, loc);
        }
        if (this.context.errorClassRoots().length > 0) {
          this.context.unsupported("dynamic Error boxing alongside user Error subclasses", loc);
        }
        const error = this.context.nextTemporary();
        return `{ let ${error} = ${value}; sc_dyn_error_box(&${error}) }`;
      }
      case "record": {
        const shape = this.context.records.get(type.shapeId);
        if (shape?.indexValue?.kind === "dyn" && shape.fields.length === 0) {
          return `sc_dyn_deep_copy(&${name}::Object(${value}))`;
        }
        if (shape?.indexValue !== undefined && shape.fields.length === 0) {
          const source = this.context.nextTemporary();
          const output = this.context.nextTemporary();
          const index = this.context.nextTemporary();
          const field = this.emitDynFromValue(
            shape.indexValue,
            `runtime::map_iter_value(&${source}, ${index})`,
            loc,
          );
          return `{ let ${source} = ${value}; let ${output}: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new(); let mut ${index} = 0.0; while ${index} < runtime::map_iter_count(&${source}) { if runtime::map_iter_live(&${source}, ${index}) { let key = runtime::map_iter_key(&${source}, ${index}); runtime::map_set_by(&${output}, key, ${field}, |left, right| left.as_ref() == right.as_ref()); } ${index} += 1.0; } ${name}::Object(${output}) }`;
        }
        if (shape === undefined || shape.indexValue !== undefined) {
          this.context.unsupported(`dynamic boxing from record '${type.shapeId}'`, loc);
        }
        const record = this.context.nextTemporary();
        const object = this.context.nextTemporary();
        const byName = new Map(shape.fields.map((field) => [field.name, field]));
        const fields = (shape.declaredOrder ?? shape.fields.map((field) => field.name)).map((fieldName) => {
          const field = byName.get(fieldName);
          if (field === undefined) this.context.unsupported(`missing declared record field '${type.shapeId}.${fieldName}'`, loc);
          const stored = `${record}.${mangleField(field.name)}`;
          const fieldValue = this.context.isEdgeValue(field.type)
            ? `${stored}.as_ref().expect("scriptc: cleared live dynamic record field").clone()`
            : this.context.needsClone(field.type) ? `${stored}.clone()` : stored;
          const dynamic = this.emitDynFromValue(field.type, fieldValue, loc);
          return `runtime::map_set_by(&${object}, runtime::string("${this.context.rustString(field.name)}"), ${dynamic}, |left, right| left.as_ref() == right.as_ref());`;
        }).join(" ");
        return `{ let ${record} = ${value}; let ${object}: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new(); ${record}.with(|${record}| { ${fields} }); ${name}::Object(${object}) }`;
      }
      default:
        this.context.unsupported(`dynamic boxing from '${type.kind}'`, loc);
    }
  }

  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string {
    switch (type.kind) {
      case "dyn": return value;
      case "f64": return `sc_dyn_check_number(${value})`;
      case "bool": return `sc_dyn_check_boolean(${value})`;
      case "string": return `sc_dyn_check_string(${value})`;
      case "bytes": {
        if (type.elem !== "u8") this.context.unsupported(`dynamic checked cast to bytes<${type.elem}>`, loc);
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::Bytes(bytes) => runtime::bytes_copy(&bytes), value => sc_dyn_check_fail("bytes", &value), } }`;
      }
      case "func": return `${this.context.dynFunctionCheckName(this.context.closureShapeForType(type, loc))}(${value})`;
      case "union": {
        if (!this.context.isRustJsonCompatible(type)) {
          this.context.unsupported("dynamic checked cast to union", loc);
        }
        const union = this.context.union(type.unionId, loc);
        const dyn = this.context.dynTypeName();
        const name = this.context.unionName(union.id);
        const rustType = this.context.rustType(type, loc);
        const units = union.arms.flatMap((arm, tag) => {
          if (arm.kind !== "undefinedT" && arm.kind !== "nullT") return [];
          const source = arm.kind === "undefinedT" ? "Undefined" : "Null";
          return [`${dyn}::${source} => ${name}::${this.context.unionVariant(tag)}`];
        });
        const decode = `let node = sc_dyn_to_json(&value, "$").unwrap_or_else(|message| runtime::throw_type_error(message)); <${rustType} as runtime::JsonDecode>::decode_json(&node, "$").unwrap_or_else(|message| runtime::throw_type_error(message))`;
        return units.length === 0
          ? `{ let value = ${value}; ${decode} }`
          : `{ let value = ${value}; match value { ${units.join(", ")}, value => { ${decode} }, } }`;
      }
      case "array":
      case "record": {
        if (type.kind === "record") {
          const shape = this.context.records.get(type.shapeId);
          if (shape?.indexValue?.kind === "dyn" && shape.fields.length === 0) {
            const name = this.context.dynTypeName();
            return `{ let value = ${value}; match &value { ${name}::Object(..) => match sc_dyn_deep_copy(&value) { ${name}::Object(object) => object, _ => unreachable!("scriptc invariant: copied dyn object changed kind"), }, _ => sc_dyn_check_fail("object", &value), } }`;
          }
        }
        if (!this.context.isRustJsonCompatible(type)) {
          this.context.unsupported(`dynamic checked cast to '${type.kind}'`, loc);
        }
        const rustType = this.context.rustType(type, loc);
        return `{ let value = ${value}; let node = sc_dyn_to_json(&value, "$").unwrap_or_else(|message| runtime::throw_type_error(message)); <${rustType} as runtime::JsonDecode>::decode_json(&node, "$").unwrap_or_else(|message| runtime::throw_type_error(message)) }`;
      }
      default:
        this.context.unsupported(`dynamic checked cast to '${type.kind}'`, loc);
    }
  }

}
