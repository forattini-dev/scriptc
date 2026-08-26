import type { IrModule, IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
import { mangleField } from "../mangle.js";
import { emitRustDynamicInvoke } from "./dynamic-invoke.js";
import { emitRustDynamicAssertions } from "./dynamic-assertions.js";
import { emitRustDynamicObjectWalk } from "./dynamic-object-walk.js";
import { emitRustQuerystringDynImpl } from "./querystring.js";
import type { IrFuncType, RustClassMeta, RustClosureShape } from "./model.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";

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
    this.context.line("Buffer(runtime::JsBytes<u8>),");
    this.context.line("Promise(runtime::JsPromiseHandle),");
    this.context.line("NetServer(runtime::JsNetServer),");
    this.context.line("NetSocket(runtime::JsNetSocket),");
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
    this.context.line("Self::Buffer(value) => tracer.edge(value),");
    this.context.line("Self::Promise(value) => runtime::promise_handle_trace(value, tracer),");
    this.context.line("Self::NetServer(value) => tracer.edge(value),");
    this.context.line("Self::NetSocket(value) => tracer.edge(value),");
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
    emitRustQuerystringDynImpl(name, this.context);
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
    this.context.line(`${name}::Buffer(value) => runtime::JsonValue::write_json(&${name}::Bytes(value.clone()), writer),`);
    this.context.line(`${name}::Array(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Object(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Promise(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::NetServer(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::NetSocket(..) => { writer.begin_object(); writer.end_object(); },`);
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
    this.context.line(`impl runtime::ParseArgsValue for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn parse_args_kind(&self) -> runtime::ParseArgsKind { match self {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => runtime::ParseArgsKind::Undefined,`);
    this.context.line(`${name}::Null => runtime::ParseArgsKind::Null,`);
    this.context.line(`${name}::Number(..) => runtime::ParseArgsKind::Number,`);
    this.context.line(`${name}::Boolean(..) => runtime::ParseArgsKind::Boolean,`);
    this.context.line(`${name}::String(..) => runtime::ParseArgsKind::String,`);
    this.context.line(`${name}::Array(..) => runtime::ParseArgsKind::Array,`);
    this.context.line(`${name}::Object(..) => runtime::ParseArgsKind::Object,`);
    this.context.line("_ => runtime::ParseArgsKind::Other,");
    this.context.popIndent();
    this.context.line("} }");
    this.context.line(`fn parse_args_bool(&self) -> Option<bool> { if let ${name}::Boolean(value) = self { Some(*value) } else { None } }`);
    this.context.line(`fn parse_args_number(&self) -> Option<f64> { if let ${name}::Number(value) = self { Some(*value) } else { None } }`);
    this.context.line(`fn parse_args_string(&self) -> Option<runtime::JsString> { if let ${name}::String(value) = self { Some(value.clone()) } else { None } }`);
    this.context.line(`fn parse_args_array_len(&self) -> Option<usize> { if let ${name}::Array(value) = self { Some(runtime::array_len(value) as usize) } else { None } }`);
    this.context.line(`fn parse_args_array_get(&self, index: usize) -> Option<Self> { if let ${name}::Array(value) = self { (index < runtime::array_len(value) as usize).then(|| runtime::array_get(value, index as f64)) } else { None } }`);
    this.context.line(`fn parse_args_array_push(&self, item: Self) { let ${name}::Array(value) = self else { unreachable!("scriptc: parseArgs push target is not an array") }; runtime::array_push(value, item); }`);
    this.context.line(`fn parse_args_object_entries(&self) -> Option<Vec<(runtime::JsString, Self)>> { if let ${name}::Object(value) = self { Some(runtime::map_string_entries_js_order(value)) } else { None } }`);
    this.context.line(`fn parse_args_object_set(&self, key: runtime::JsString, field: Self) { let ${name}::Object(value) = self else { unreachable!("scriptc: parseArgs set target is not an object") }; runtime::map_set_by(value, key, field, |left, right| left.as_ref() == right.as_ref()); }`);
    this.context.line(`fn parse_args_undefined() -> Self { ${name}::Undefined }`);
    this.context.line(`fn parse_args_number_value(value: f64) -> Self { ${name}::Number(value) }`);
    this.context.line(`fn parse_args_bool_value(value: bool) -> Self { ${name}::Boolean(value) }`);
    this.context.line(`fn parse_args_string_value(value: runtime::JsString) -> Self { ${name}::String(value) }`);
    this.context.line(`fn parse_args_array_value() -> Self { ${name}::Array(runtime::array_new(Vec::new())) }`);
    this.context.line(`fn parse_args_object_value() -> Self { ${name}::Object(runtime::map_new()) }`);
    this.context.line("fn parse_args_specific_type(&self) -> String { sc_dyn_specific_type(self) }");
    this.context.line("fn parse_args_inspect_lite(&self) -> String { match self {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => "undefined".to_owned(),`);
    this.context.line(`${name}::Null => "null".to_owned(),`);
    this.context.line(`${name}::Number(value) => runtime::display_number(*value),`);
    this.context.line(`${name}::Boolean(value) => runtime::display_bool(*value),`);
    this.context.line(`${name}::String(value) => format!("'{}'", value),`);
    this.context.line(`${name}::Array(..) => "[ ... ]".to_owned(),`);
    this.context.line(`${name}::Object(..) => "{ ... }".to_owned(),`);
    this.context.line(`${name}::Bytes(..) => "<Buffer ...>".to_owned(),`);
    this.context.line(`${name}::Buffer(..) => "<Buffer ...>".to_owned(),`);
    this.context.line("_ => \"[object]\".to_owned(),");
    this.context.popIndent();
    this.context.line("} }");
    this.context.line("fn parse_args_display(&self) -> String { sc_dyn_to_string(self).to_string() }");
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
    this.context.line(`${name}::Buffer(value) => ${name}::Buffer(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::Promise(value) => ${name}::Promise(value.clone()),`);
    this.context.line(`${name}::NetServer(value) => ${name}::NetServer(value.clone()),`);
    this.context.line(`${name}::NetSocket(value) => ${name}::NetSocket(value.clone()),`);
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
    this.context.line(`${name}::Buffer(..) => Err(format!("buffer at {path} is not JSON data")),`);
    this.context.line(`${name}::Promise(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::NetServer(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::NetSocket(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
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
    this.context.line(`${name}::Buffer(..) => "bytes",`);
    this.context.line(`${name}::Array(..) => "array",`);
    this.context.line(`${name}::Object(..) => "object",`);
    this.context.line(`${name}::Promise(..) => "promise",`);
    this.context.line(`${name}::NetServer(..) => "object",`);
    this.context.line(`${name}::NetSocket(..) => "object",`);
    if (boxedShapes.length > 0) {
      this.context.line(`${boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_is_truthy(value: &${name}) -> bool {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined | ${name}::Null => false,`);
    this.context.line(`${name}::Number(value) => *value != 0.0 && !value.is_nan(),`);
    this.context.line(`${name}::Boolean(value) => *value,`);
    this.context.line(`${name}::String(value) => !value.is_empty(),`);
    this.context.line("_ => true,");
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
    this.context.line(`${name}::Buffer(..) => "object",`);
    this.context.line(`${name}::NetServer(..) => "object",`);
    this.context.line(`${name}::NetSocket(..) => "object",`);
    if (boxedShapes.length > 0) {
      this.context.line(`${boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
    }
    this.context.line("_ => \"object\",");
    this.context.popIndent();
    this.context.line("};");
    this.context.line("runtime::string(kind)");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_from_caught(caught: runtime::Caught) -> ${name} {`);
    this.context.pushIndent();
    this.context.line(`if runtime::caught_is::<${name}>(&caught) { runtime::caught_narrow::<${name}>(&caught) }`);
    this.context.line(`else if runtime::caught_is::<f64>(&caught) { ${name}::Number(runtime::caught_narrow::<f64>(&caught)) }`);
    this.context.line(`else if runtime::caught_is::<bool>(&caught) { ${name}::Boolean(runtime::caught_narrow::<bool>(&caught)) }`);
    this.context.line(`else if runtime::caught_is::<runtime::JsString>(&caught) { ${name}::String(runtime::caught_narrow::<runtime::JsString>(&caught)) }`);
    this.context.line("else if runtime::caught_is_error(&caught) { sc_dyn_error_box(&runtime::caught_error_value(&caught)) }");
    this.context.line(`else { ${name}::Object(runtime::map_new()) }`);
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
    emitRustDynamicObjectWalk(this.context);
    this.context.line(`fn sc_dyn_has_own(value: &${name}, key: &runtime::JsString) -> bool {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined | ${name}::Null => runtime::throw_type_error("Cannot convert undefined or null to object".to_owned()),`);
    this.context.line(`${name}::Object(object) => runtime::map_has_by(object, key, |left, right| left.as_ref() == right.as_ref()),`);
    this.context.line(`${name}::Array(array) => key.as_ref() == "length" || sc_dyn_key_index(key).is_some_and(|index| index < runtime::array_len(array) as usize),`);
    this.context.line("_ => false,");
    this.context.popIndent();
    this.context.line("}");
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
    this.context.line(`${name}::Bytes(bytes) | ${name}::Buffer(bytes) => {`);
    this.context.pushIndent();
    this.context.line(`if key.as_ref() == "length" { ${name}::Number(runtime::bytes_len(bytes)) }`);
    this.context.line(`else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::bytes_len(bytes) as usize { ${name}::Number(runtime::bytes_get(bytes, index as f64)) } else { ${name}::Undefined } }`);
    this.context.line(`else { ${name}::Undefined }`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::NetSocket(socket) => match key.as_ref() {`);
    this.context.pushIndent();
    this.context.line(`"destroyed" => ${name}::Boolean(runtime::net_socket_destroyed(socket)),`);
    this.context.line(`"writable" => ${name}::Boolean(runtime::net_socket_writable(socket)),`);
    this.context.line(`"readable" => ${name}::Boolean(runtime::net_socket_readable(socket)),`);
    this.context.line(`"bytesWritten" => ${name}::Number(runtime::net_socket_bytes_written(socket)),`);
    this.context.line(`"remoteAddress" => runtime::net_socket_remote_address(socket).map(${name}::String).unwrap_or(${name}::Undefined),`);
    this.context.line(`"encrypted" => runtime::tls_socket_encrypted(socket).map(${name}::Boolean).unwrap_or(${name}::Undefined),`);
    this.context.line(`"authorized" => ${name}::Boolean(runtime::tls_socket_authorized(socket)),`);
    this.context.line(`"authorizationError" => runtime::tls_socket_authorization_error(socket).map(${name}::String).unwrap_or(${name}::Null),`);
    this.context.line(`_ => ${name}::Undefined,`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::NetServer(server) => {`);
    this.context.pushIndent();
    this.context.line("let Some(selector) = runtime::http_server_timeout_selector(key) else { return " + `${name}::Undefined; };`);
    this.context.line(`match runtime::http_server_timeout_value(server, selector) { Some(runtime::JsHttpTimeout::Undefined) | None => ${name}::Undefined, Some(runtime::JsHttpTimeout::Number(value)) => ${name}::Number(value), Some(runtime::JsHttpTimeout::String(value)) => ${name}::String(value), }`);
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
    this.context.line(`${name}::NetServer(server) => {`);
    this.context.pushIndent();
    this.context.line("let Some(selector) = runtime::http_server_timeout_selector(&key) else { sc_dyn_key_set_error(value, &key); };");
    this.context.line(`let stored = match &field { ${name}::Undefined => runtime::http_server_timeout_set_undefined(server, selector), ${name}::Number(number) => runtime::http_server_timeout_set_number_dynamic(server, selector, *number), ${name}::String(text) => runtime::http_server_timeout_set_string(server, selector, text), _ => false, };`);
    this.context.line("if !stored { sc_dyn_key_set_error(value, &key); }");
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
    this.context.line(`${name}::Buffer(value) => runtime::bytes_to_string(value, &runtime::string("utf8")),`);
    this.context.line(`${name}::Promise(..) => runtime::string("[object Promise]"),`);
    this.context.line(`${name}::NetServer(..) => runtime::string("[object Object]"),`);
    this.context.line(`${name}::NetSocket(..) => runtime::string("[object Object]"),`);
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
    this.context.line(`${name}::Buffer(..) => "an instance of Buffer".to_owned(),`);
    this.context.line(`${name}::Array(..) => "an instance of Array".to_owned(),`);
    this.context.line(`${name}::Object(..) => "an instance of Object".to_owned(),`);
    this.context.line(`${name}::Promise(..) => "an instance of Promise".to_owned(),`);
    this.context.line(`${name}::NetServer(..) => "an instance of Server".to_owned(),`);
    this.context.line(`${name}::NetSocket(..) => "an instance of Socket".to_owned(),`);
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
    this.context.line(`fn sc_dyn_prop_type_fail(name: &str, expected: &str, value: &${name}) -> ! {`);
    this.context.pushIndent();
    this.context.line("runtime::throw_type_error_code(format!(\"The \\\"{name}\\\" property must be {expected}. Received {}\", sc_dyn_specific_type(value)), \"ERR_INVALID_ARG_TYPE\")");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_arg_value_fail(name: &str, reason: &str, value: &${name}) -> ! {`);
    this.context.pushIndent();
    this.context.line("let category = if name.contains('.') { \"property\" } else { \"argument\" };");
    this.context.line("runtime::throw_type_error_code(format!(\"The {category} '{name}' {reason}. Received {}\", runtime::ParseArgsValue::parse_args_inspect_lite(value)), \"ERR_INVALID_ARG_VALUE\")");
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
    this.context.line(`${name}::Buffer(value) => runtime::inspect_buffer(value),`);
    this.context.line(`${name}::Promise(..) => runtime::string("Promise { <pending> }"),`);
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
    this.context.line(`${name}::NetSocket(..) => runtime::string("Socket {}"),`);
    this.context.line(`${name}::NetServer(..) => runtime::string("Server {}"),`);
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
    this.context.line(`fn sc_dyn_error_unbox(value: ${name}) -> runtime::JsError {`);
    this.context.pushIndent();
    this.context.line(`let ${name}::Object(object) = &value else { return sc_dyn_check_fail("Error", &value); };`);
    this.context.line("let identity = object.identity();");
    this.context.line("SC_DYN_ERROR_CACHE.with(|cache| cache.borrow().iter().find(|(_, _, cached)| cached.identity() == identity).map(|(_, error, _)| error.clone())).unwrap_or_else(|| sc_dyn_check_fail(\"Error\", &value))");
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
    this.context.line(`${name}::Buffer(value) => ${name}::Buffer(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::Promise(..) => runtime::throw_dom_exception("DataCloneError", "#<Promise> could not be cloned."),`);
    this.context.line(`${name}::NetServer(..) => runtime::throw_dom_exception("DataCloneError", "#<Server> could not be cloned."),`);
    this.context.line(`${name}::NetSocket(..) => runtime::throw_dom_exception("DataCloneError", "#<Socket> could not be cloned."),`);
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
    this.context.line(`(${name}::NetServer(left), ${name}::NetServer(right)) => left.ptr_eq(right),`);
    this.context.line(`(${name}::NetSocket(left), ${name}::NetSocket(right)) => left.ptr_eq(right),`);
    this.context.line(`(${name}::Bytes(left), ${name}::Bytes(right)) => {`);
    this.context.pushIndent();
    this.context.line("if left.ptr_eq(right) { true } else if !deep || runtime::bytes_len(left) != runtime::bytes_len(right) { false } else {");
    this.context.pushIndent();
    this.context.line("let mut index = 0.0; let mut equal = true; while equal && index < runtime::bytes_len(left) { equal = runtime::bytes_get(left, index) == runtime::bytes_get(right, index); index += 1.0; } equal");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`(${name}::Buffer(left), ${name}::Buffer(right)) => left.ptr_eq(right) || (deep && runtime::bytes_deep_equals(left, right)),`);
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

  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName = "", liveRef = false): string {
    const name = this.context.dynTypeName();
    switch (type.kind) {
      case "dyn": return value;
      case "f64": return `${name}::Number(${value})`;
      case "bool": return `${name}::Boolean(${value})`;
      case "string": return `${name}::String(${value})`;
      case "bytes": {
        if (type.elem !== "u8") this.context.unsupported(`dynamic boxing from bytes<${type.elem}>`, loc);
        return liveRef ? `{ let source = ${value}; let mirror = runtime::bytes_copy(&source); runtime::live_dyn_ref_store(mirror.identity(), source); ${name}::Bytes(mirror) }` : `${name}::Bytes(runtime::bytes_copy(&(${value})))`;
      }
      case "promise": return `${name}::Promise(runtime::promise_to_handle(&(${value})))`;
      case "netServer": return `${name}::NetServer(${value})`;
      case "netSocket": return `${name}::NetSocket(${value})`;
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
          loc, "", liveRef,
        );
        return `{ let ${source} = ${value}; let ${output}: runtime::JsArray<${name}> = runtime::array_new(Vec::new()); let mut ${index} = 0.0; while ${index} < runtime::array_len(&${source}) { runtime::array_push(&${output}, ${element}); ${index} += 1.0; } ${liveRef ? `runtime::live_dyn_ref_store(${output}.identity(), ${source}); ` : ""}${name}::Array(${output}) }`;
      }
      case "union": {
        const union = this.context.union(type.unionId, loc);
        const unionValue = this.context.nextTemporary();
        const arms = union.arms.map((arm, tag) => {
          const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(tag)}`;
          if (this.context.isUnit(arm)) {
            return `${variant} => ${this.emitDynFromValue(arm, "()", loc, "", liveRef)}`;
          }
          return `${variant}(payload) => ${this.emitDynFromValue(arm, "payload", loc, "", liveRef)}`;
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
        if (shape?.tuple) {
          const record = this.context.nextTemporary();
          const output = this.context.nextTemporary();
          const fields = [...shape.fields]
            .sort((left, right) => Number(left.name) - Number(right.name))
            .map((field) => {
              const stored = `${record}.${mangleField(field.name)}`;
              const fieldValue = this.context.isEdgeValue(field.type)
                ? `${stored}.as_ref().expect("scriptc: cleared live dynamic tuple field").clone()`
                : this.context.needsClone(field.type) ? `${stored}.clone()` : stored;
              return `runtime::array_push(&${output}, ${this.emitDynFromValue(field.type, fieldValue, loc, "", liveRef)});`;
            }).join(" ");
          return `{ let ${record} = ${value}; let ${output}: runtime::JsArray<${name}> = runtime::array_new(Vec::new()); ${record}.with(|${record}| { ${fields} }); ${liveRef ? `runtime::live_dyn_ref_store(${output}.identity(), ${record}); ` : ""}${name}::Array(${output}) }`;
        }
        if (shape?.indexValue?.kind === "dyn" && shape.fields.length === 0) {
          return liveRef ? `{ let source = ${value}; let mirror = match sc_dyn_deep_copy(&${name}::Object(source.clone())) { ${name}::Object(value) => value, _ => unreachable!() }; runtime::live_dyn_ref_store(mirror.identity(), source); ${name}::Object(mirror) }` : `sc_dyn_deep_copy(&${name}::Object(${value}))`;
        }
        if (shape?.indexValue !== undefined && shape.fields.length === 0) {
          const source = this.context.nextTemporary();
          const output = this.context.nextTemporary();
          const index = this.context.nextTemporary();
          const field = this.emitDynFromValue(
            shape.indexValue,
            `runtime::map_iter_value(&${source}, ${index})`,
            loc, "", liveRef,
          );
          return `{ let ${source} = ${value}; let ${output}: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new(); let mut ${index} = 0.0; while ${index} < runtime::map_iter_count(&${source}) { if runtime::map_iter_live(&${source}, ${index}) { let key = runtime::map_iter_key(&${source}, ${index}); runtime::map_set_by(&${output}, key, ${field}, |left, right| left.as_ref() == right.as_ref()); } ${index} += 1.0; } ${liveRef ? `runtime::live_dyn_ref_store(${output}.identity(), ${source}); ` : ""}${name}::Object(${output}) }`;
        }
        if (shape === undefined) {
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
          const dynamic = this.emitDynFromValue(field.type, fieldValue, loc, "", liveRef);
          return `runtime::map_set_by(&${object}, runtime::string("${this.context.rustString(field.name)}"), ${dynamic}, |left, right| left.as_ref() == right.as_ref());`;
        }).join(" ");
        const overflow = shape.indexValue === undefined ? "" : (() => {
          const source = this.context.nextTemporary();
          const index = this.context.nextTemporary();
          const dynamic = shape.indexValue.kind === "dyn"
            ? `runtime::map_iter_value(&${source}, ${index})`
            : this.emitDynFromValue(shape.indexValue, `runtime::map_iter_value(&${source}, ${index})`, loc, "", liveRef);
          return `let ${source} = ${record}.${RUST_RECORD_OVERFLOW}.as_ref().expect("scriptc: cleared live record overflow").clone(); let mut ${index} = 0.0; while ${index} < runtime::map_iter_count(&${source}) { if runtime::map_iter_live(&${source}, ${index}) { let sc_key = runtime::map_iter_key(&${source}, ${index}); runtime::map_set_by(&${object}, sc_key, ${dynamic}, |left, right| left.as_ref() == right.as_ref()); } ${index} += 1.0; }`;
        })();
        return `{ let ${record} = ${value}; let ${object}: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new(); ${record}.with(|${record}| { ${fields} ${overflow} }); ${liveRef ? `runtime::live_dyn_ref_store(${object}.identity(), ${record}); ` : ""}${name}::Object(${object}) }`;
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
        return `{ let value = ${value}; match value { ${name}::Bytes(bytes) | ${name}::Buffer(bytes) => runtime::live_dyn_ref_get(bytes.identity()).unwrap_or_else(|| runtime::bytes_copy(&bytes)), value => sc_dyn_check_fail("bytes", &value), } }`;
      }
      case "netSocket": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::NetSocket(socket) => socket, value => sc_dyn_check_fail("Socket", &value), } }`;
      }
      case "netServer": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::NetServer(server) => server, value => sc_dyn_check_fail("Server", &value), } }`;
      }
      case "func": return `${this.context.dynFunctionCheckName(this.context.closureShapeForType(type, loc))}(${value})`;
      case "object": {
        if (!RUNTIME_ERROR_CLASSES.has(type.className) || this.context.errorClassRoots().length > 0) {
          this.context.unsupported(`dynamic checked cast to object '${type.className}'`, loc);
        }
        return `sc_dyn_error_unbox(${value})`;
      }
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
            return `{ let value = ${value}; match &value { ${name}::Object(object) => runtime::live_dyn_ref_get(object.identity()).unwrap_or_else(|| match sc_dyn_deep_copy(&value) { ${name}::Object(object) => object, _ => unreachable!("scriptc invariant: copied dyn object changed kind"), }), _ => sc_dyn_check_fail("object", &value), } }`;
          }
        }
        if (!this.context.isRustJsonCompatible(type)) {
          this.context.unsupported(`dynamic checked cast to '${type.kind}'`, loc);
        }
        const rustType = this.context.rustType(type, loc);
        const live = type.kind === "array" ? `${this.context.dynTypeName()}::Array(mirror)` : `${this.context.dynTypeName()}::Object(mirror)`;
        return `{ let value = ${value}; let live: Option<${rustType}> = match &value { ${live} => runtime::live_dyn_ref_get(mirror.identity()), _ => None }; live.unwrap_or_else(|| { let node = sc_dyn_to_json(&value, "$").unwrap_or_else(|message| runtime::throw_type_error(message)); <${rustType} as runtime::JsonDecode>::decode_json(&node, "$").unwrap_or_else(|message| runtime::throw_type_error(message)) }) }`;
      }
      default:
        this.context.unsupported(`dynamic checked cast to '${type.kind}'`, loc);
    }
  }

}
