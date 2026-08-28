import type { IrModule, IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
import { emitRustDynamicInvoke } from "./dynamic-invoke.js";
import { emitRustDynamicHttp } from "./dynamic-http.js";
import { emitRustDynamicAgent } from "./dynamic-agent.js";
import { emitRustDynamicAssertions } from "./dynamic-assertions.js";
import { emitRustDynamicInspect } from "./dynamic-inspect.js";
import { emitRustDynamicScalarChecks } from "./dynamic-scalars.js";
import { RustDynamicFromEmitter } from "./dynamic-from.js";
import { emitRustDynamicObjectWalk } from "./dynamic-object-walk.js";
import { emitRustQuerystringDynImpl } from "./querystring.js";
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
  errorValueName(): string;
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
  private readonly dynFrom: RustDynamicFromEmitter;

  constructor(private readonly context: RustDynamicContext) {
    this.dynFrom = new RustDynamicFromEmitter(context);
  }

  emitDynamicDefinition(): void {
    if (!this.context.usesDyn()) return;
    const name = this.context.dynTypeName();
    const caughtErrorTest = this.context.errorClassRoots().length === 0 ? "runtime::caught_is_error(&caught)" : "sc_caught_is_error_class(&caught, \"Error\")";
    const caughtErrorValue = this.context.errorClassRoots().length === 0 ? "runtime::caught_error_value(&caught)" : "sc_caught_error_value(&caught)";
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
    this.context.line("Regex(runtime::JsRegex),");
    this.context.line("Url(runtime::JsUrl),");
    this.context.line("Bytes(runtime::JsBytes<u8>),");
    this.context.line("TypedBytes(runtime::JsTypedBytes),");
    this.context.line("Buffer(runtime::JsBytes<u8>),");
    this.context.line("NativeConstructor(&'static str),");
    this.context.line("Promise(runtime::JsPromiseHandle),");
    this.context.line("NetServer(runtime::JsNetServer),");
    this.context.line("NetSocket(runtime::JsNetSocket),");
    this.context.line("HttpRequest(runtime::JsHttpRequest),");
    this.context.line("HttpResponse(runtime::JsHttpResponse),");
    this.context.line("HttpAgent(runtime::JsHttpAgent),");
    this.context.line(`Array(runtime::JsArray<${name}>),`);
    this.context.line(`Object(runtime::JsMap<runtime::JsString, ${name}>),`);
    this.context.line(`Getter(Box<${name}>),`);
    for (const shape of boxedShapes) {
      this.context.line(`${this.context.dynFunctionVariant(shape)}(runtime::Gc<${this.context.closureName(shape)}>, runtime::JsString, runtime::JsMap<runtime::JsString, ${name}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_mark_null_proto(object: &runtime::JsMap<runtime::JsString, ${name}>) { runtime::map_mark_null_prototype(object); }`);
    this.context.line(`fn sc_dyn_is_null_proto(object: &runtime::JsMap<runtime::JsString, ${name}>) -> bool { runtime::map_has_null_prototype(object) }`);
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
    this.context.line("Self::Getter(value) => runtime::Trace::trace(value.as_ref(), tracer),");
    this.context.line("Self::Bytes(value) => tracer.edge(value),");
    this.context.line("Self::TypedBytes(value) => runtime::typed_bytes_trace(value, tracer),");
    this.context.line("Self::Buffer(value) => tracer.edge(value),");
    this.context.line("Self::Promise(value) => runtime::promise_handle_trace(value, tracer),");
    this.context.line("Self::NetServer(value) => tracer.edge(value),");
    this.context.line("Self::NetSocket(value) => tracer.edge(value),");
    this.context.line("Self::HttpRequest(value) => tracer.edge(value),");
    this.context.line("Self::HttpResponse(value) => tracer.edge(value),");
    this.context.line("Self::HttpAgent(value) => tracer.edge(value),");
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
    this.context.line(`${name}::Regex(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::Url(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::Bytes(value) => {`);
    this.context.pushIndent();
    this.context.line("writer.begin_object();");
    this.context.line("let mut first = true;");
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::bytes_len(value) { writer.property(&mut first, &(index as usize).to_string(), &runtime::bytes_get(value, index)); index += 1.0; }");
    this.context.line("writer.end_object();");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::TypedBytes(value) => { writer.begin_object(); let mut first = true; let mut index = 0.0; while index < runtime::typed_bytes_len(value) { writer.property(&mut first, &(index as usize).to_string(), &runtime::typed_bytes_get(value, index)); index += 1.0; } writer.end_object(); },`);
    this.context.line(`${name}::Buffer(value) => runtime::JsonValue::write_json(&${name}::Bytes(value.clone()), writer),`);
    this.context.line(`${name}::Array(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Object(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Getter(..) => writer.write_null(),`);
    this.context.line(`${name}::Promise(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::NetServer(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::NetSocket(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::HttpRequest(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => { writer.begin_object(); writer.end_object(); },`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(..) => writer.write_null(),`);
    }
    this.context.line(`${name}::NativeConstructor(..) => writer.write_null(),`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn is_json_undefined(&self) -> bool {");
    this.context.pushIndent();
    const undefinedPatterns = [
      `${name}::Undefined`,
      `${name}::NativeConstructor(..)`,
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
    this.context.line(`${name}::TypedBytes(value) => format!("<{} ...>", runtime::typed_bytes_name(value)),`);
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
    this.context.line(`${name}::Regex(value) => ${name}::Regex(value.clone()),`);
    this.context.line(`${name}::Url(value) => ${name}::Url(value.clone()),`);
    this.context.line(`${name}::Bytes(value) => ${name}::Bytes(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::TypedBytes(value) => ${name}::TypedBytes(runtime::typed_bytes_copy(value)),`);
    this.context.line(`${name}::Buffer(value) => ${name}::Buffer(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::Promise(value) => ${name}::Promise(value.clone()),`);
    this.context.line(`${name}::NetServer(value) => ${name}::NetServer(value.clone()),`);
    this.context.line(`${name}::NetSocket(value) => ${name}::NetSocket(value.clone()),`);
    this.context.line(`${name}::HttpRequest(value) => ${name}::HttpRequest(value.clone()),`);
    this.context.line(`${name}::HttpResponse(value) => ${name}::HttpResponse(value.clone()),`);
    this.context.line(`${name}::HttpAgent(value) => ${name}::HttpAgent(value.clone()),`);
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
    this.context.line("if sc_dyn_is_null_proto(value) { sc_dyn_mark_null_proto(&output); }");
    this.context.line(`${name}::Object(output)`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Getter(value) => ${name}::Getter(Box::new(sc_dyn_deep_copy(value.as_ref()))),`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(value, function_name, properties) => ${name}::${this.context.dynFunctionVariant(shape)}(value.clone(), function_name.clone(), properties.clone()),`);
    }
    this.context.line(`${name}::NativeConstructor(name) => ${name}::NativeConstructor(name),`);
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
    this.context.line(`${name}::Regex(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::Url(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::Bytes(..) => Err(format!("bytes at {path} is not JSON data")),`);
    this.context.line(`${name}::TypedBytes(..) => Err(format!("typed array at {path} is not JSON data")),`);
    this.context.line(`${name}::Buffer(..) => Err(format!("buffer at {path} is not JSON data")),`);
    this.context.line(`${name}::Promise(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::NetServer(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::NetSocket(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::HttpRequest(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
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
    this.context.line(`${name}::Getter(..) => Err(format!("accessor at {path} is not JSON data")),`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(..) => Err(format!("function at {path} is not JSON data")),`);
    }
    this.context.line(`${name}::NativeConstructor(..) => Err(format!("function at {path} is not JSON data")),`);
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
    this.context.line(`${name}::Regex(..) => "object",`);
    this.context.line(`${name}::Url(..) => "object",`);
    this.context.line(`${name}::Bytes(..) => "bytes",`);
    this.context.line(`${name}::TypedBytes(..) => "bytes",`);
    this.context.line(`${name}::Buffer(..) => "bytes",`);
    this.context.line(`${name}::Array(..) => "array",`);
    this.context.line(`${name}::Object(..) => "object",`);
    this.context.line(`${name}::Getter(..) => "function",`);
    this.context.line(`${name}::Promise(..) => "promise",`);
    this.context.line(`${name}::NetServer(..) => "object",`);
    this.context.line(`${name}::NetSocket(..) => "object",`);
    this.context.line(`${name}::HttpRequest(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => "object",`);
    if (boxedShapes.length > 0) {
      this.context.line(`${boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
    }
    this.context.line(`${name}::NativeConstructor(..) => "function",`);
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
    this.context.line(`fn sc_dyn_iter_n(value: &${name}, count: usize) -> ${name} {`);
    this.context.pushIndent();
    this.context.line(`let output: runtime::JsArray<${name}> = runtime::array_new(Vec::new());`);
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Array(array) => for index in 0..count { let index = index as f64; runtime::array_push(&output, if index < runtime::array_len(array) { runtime::array_get(array, index) } else { ${name}::Undefined }); },`);
    this.context.line(`${name}::String(text) => { let mut chars = text.chars(); for _ in 0..count { runtime::array_push(&output, chars.next().map_or(${name}::Undefined, |character| ${name}::String(runtime::string(&character.to_string())))); } },`);
    this.context.line(`${name}::Bytes(bytes) | ${name}::Buffer(bytes) => for index in 0..count { let index = index as f64; runtime::array_push(&output, if index < runtime::bytes_len(bytes) { ${name}::Number(runtime::bytes_get(bytes, index)) } else { ${name}::Undefined }); },`);
    this.context.line(`${name}::TypedBytes(bytes) => for index in 0..count { let index = index as f64; runtime::array_push(&output, if index < runtime::typed_bytes_len(bytes) { ${name}::Number(runtime::typed_bytes_get(bytes, index)) } else { ${name}::Undefined }); },`);
    this.context.line("other => {");
    this.context.pushIndent();
    this.context.line("let description = match other {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => "undefined".to_owned(),`);
    this.context.line(`${name}::Null => "object null".to_owned(),`);
    this.context.line(`${name}::Boolean(value) => format!("boolean {value}"),`);
    this.context.line(`${name}::Number(value) => format!("number {}", runtime::display_number(*value)),`);
    if (boxedShapes.length > 0) {
      this.context.line(`${boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function".to_owned(),`);
    }
    this.context.line("_ => \"object\".to_owned(),");
    this.context.popIndent();
    this.context.line("};");
    this.context.line("runtime::throw_type_error(format!(\"{description} is not iterable (cannot read property Symbol(Symbol.iterator))\"));");
    this.context.popIndent();
    this.context.line("},");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`${name}::Array(output)`);
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
    this.context.line(`${name}::TypedBytes(..) => "object",`);
    this.context.line(`${name}::Buffer(..) => "object",`);
    this.context.line(`${name}::NetServer(..) => "object",`);
    this.context.line(`${name}::NetSocket(..) => "object",`);
    if (boxedShapes.length > 0) {
      this.context.line(`${boxedShapes.map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`).join(" | ")} => "function",`);
    }
    this.context.line(`${name}::NativeConstructor(..) => "function",`);
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
    this.context.line(`else if ${caughtErrorTest} { sc_dyn_error_box(&${caughtErrorValue}) }`);
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
    const getterRead = this.context.usesDynamicInvoke()
      ? `{ let _this_guard = sc_dyn_this_push(receiver.clone()); sc_dyn_call(getter.as_ref(), &[], key.as_ref()) }`
      : "sc_dyn_call(getter.as_ref(), &[], key.as_ref())";
    this.context.line(`fn sc_dyn_object_key_get(object: &runtime::JsMap<runtime::JsString, ${name}>, key: &runtime::JsString, receiver: &${name}) -> ${name} {`);
    this.context.pushIndent();
    this.context.line(`match runtime::map_get_by(object, key, |left, right| left.as_ref() == right.as_ref()) { Some(${name}::Getter(getter)) => ${getterRead}, Some(field) => field, None => match runtime::map_prototype(object) { Some(${name}::Object(prototype)) => sc_dyn_object_key_get(&prototype, key, receiver), _ => ${name}::Undefined, }, }`);
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
    this.context.line(`${name}::Object(object) => sc_dyn_object_key_get(object, key, value),`);
    this.context.line(`${name}::Regex(regex) => match key.as_ref() { "source" => ${name}::String(runtime::regex_source(regex)), "flags" => ${name}::String(runtime::regex_flags(regex)), "lastIndex" => ${name}::Number(runtime::regex_last_index(regex)), _ => ${name}::Undefined, },`);
    this.context.line(`${name}::Url(url) => match key.as_ref() { "href" => ${name}::String(runtime::url_href(url)), "protocol" => ${name}::String(runtime::url_protocol(url)), "host" => ${name}::String(runtime::url_host(url)), "hostname" => ${name}::String(runtime::url_hostname(url)), "pathname" => ${name}::String(runtime::url_pathname(url)), _ => ${name}::Undefined, },`);
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
    this.context.line(`else if key.as_ref() == "constructor" { ${name}::NativeConstructor(if matches!(value, ${name}::Buffer(..)) { "Buffer" } else { "Uint8Array" }) }`);
    this.context.line(`else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::bytes_len(bytes) as usize { ${name}::Number(runtime::bytes_get(bytes, index as f64)) } else { ${name}::Undefined } }`);
    this.context.line(`else { ${name}::Undefined }`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::TypedBytes(bytes) => { if key.as_ref() == "length" { ${name}::Number(runtime::typed_bytes_len(bytes)) } else if key.as_ref() == "constructor" { ${name}::NativeConstructor(runtime::typed_bytes_name(bytes)) } else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::typed_bytes_len(bytes) as usize { ${name}::Number(runtime::typed_bytes_get(bytes, index as f64)) } else { ${name}::Undefined } } else { ${name}::Undefined } },`);
    this.context.line(`${name}::NativeConstructor(name) => if key.as_ref() == "name" { ${name}::String(runtime::string(name)) } else { ${name}::Undefined },`);
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
    this.context.line(`${name}::HttpRequest(request) => sc_dyn_http_request_get(request, key),`);
    this.context.line(`${name}::HttpResponse(response) => sc_dyn_http_response_get(response, key),`);
    this.context.line(`${name}::HttpAgent(agent) => sc_dyn_http_agent_get(agent, key),`);
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
    this.context.line(`${name}::Regex(regex) if key.as_ref() == "lastIndex" => match field { ${name}::Number(value) => runtime::regex_set_last_index(regex, value), _ => runtime::regex_set_last_index(regex, 0.0), },`);
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
    this.context.line(`${name}::HttpResponse(response) => { if !sc_dyn_http_response_set(response, &key, &field) { sc_dyn_key_set_error(value, &key); } },`);
    this.context.line(`${name}::HttpAgent(agent) => { if !sc_dyn_http_agent_set(agent, &key, &field) { sc_dyn_key_set_error(value, &key); } },`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(_, _, properties) => runtime::map_set_by(properties, key, field, |left, right| left.as_ref() == right.as_ref()),`);
    }
    this.context.line("_ => sc_dyn_key_set_error(value, &key),");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_to_number(value: &${name}) -> f64 {`);
    this.context.pushIndent();
    this.context.line(`match value { ${name}::Undefined => f64::NAN, ${name}::Null => 0.0, ${name}::Number(value) => *value, ${name}::Boolean(value) => if *value { 1.0 } else { 0.0 }, ${name}::String(value) => runtime::number_from_string(value), _ => runtime::number_from_string(&sc_dyn_to_string(value)), }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_to_string(value: &${name}) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => runtime::string("undefined"),`);
    this.context.line(`${name}::Null => runtime::string("null"),`);
    this.context.line(`${name}::Number(value) => runtime::number_to_string(*value),`);
    this.context.line(`${name}::Boolean(value) => runtime::string(&runtime::display_bool(*value)),`);
    this.context.line(`${name}::String(value) => value.clone(),`);
    this.context.line(`${name}::Regex(value) => runtime::string(&format!("/{}/{}", runtime::regex_source(value), runtime::regex_flags(value))),`);
    this.context.line(`${name}::Url(value) => runtime::url_href(value),`);
    this.context.line(`${name}::Bytes(value) => runtime::bytes_join(value, &runtime::string(",")),`);
    this.context.line(`${name}::TypedBytes(value) => runtime::typed_bytes_join(value, &runtime::string(",")),`);
    this.context.line(`${name}::Buffer(value) => runtime::bytes_to_string(value, &runtime::string("utf8")),`);
    this.context.line(`${name}::NativeConstructor(name) => runtime::string(&format!("function {name}() {{ [native code] }}")),`);
    this.context.line(`${name}::Promise(..) => runtime::string("[object Promise]"),`);
    this.context.line(`${name}::NetServer(..) => runtime::string("[object Object]"),`);
    this.context.line(`${name}::NetSocket(..) => runtime::string("[object Object]"),`);
    this.context.line(`${name}::HttpRequest(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => runtime::string("[object Object]"),`);
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
    this.context.line("if sc_dyn_is_null_proto(object) { runtime::throw_type_error(\"Cannot convert object to primitive value\".to_owned()); }");
    this.context.line("if runtime::map_has_by(object, &runtime::string(\"%error\"), |left, right| left.as_ref() == right.as_ref()) {");
    this.context.pushIndent();
    this.context.line(`let error_name = match runtime::map_get_by(object, &runtime::string("name"), |left, right| left.as_ref() == right.as_ref()) { Some(${name}::String(value)) => value, _ => runtime::empty_string(), };`);
    this.context.line(`let message = match runtime::map_get_by(object, &runtime::string("message"), |left, right| left.as_ref() == right.as_ref()) { Some(${name}::String(value)) => value, _ => runtime::empty_string(), };`);
    this.context.line("if error_name.is_empty() { message } else if message.is_empty() { error_name } else { runtime::string(&format!(\"{error_name}: {message}\")) }");
    this.context.popIndent();
    this.context.line("} else { runtime::string(\"[object Object]\") }");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Getter(value) => sc_dyn_to_string(value.as_ref()),`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(_, function_name, _) => if function_name.is_empty() { runtime::string("function () { [native code] }") } else { runtime::string(&format!("function {}() {{ [native code] }}", function_name)) },`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    emitRustDynamicInspect(this.context, boxedShapes);
    this.context.line(`fn sc_dyn_specific_type(value: &${name}) -> String {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => "undefined".to_owned(),`);
    this.context.line(`${name}::Null => "null".to_owned(),`);
    this.context.line(`${name}::Number(value) => format!("type number ({})", runtime::format_number(*value)),`);
    this.context.line(`${name}::Boolean(value) => format!("type boolean ({value})"),`);
    this.context.line(`${name}::String(value) => runtime::dynamic_specific_string(value),`);
    this.context.line(`${name}::Regex(..) => "an instance of RegExp".to_owned(),`);
    this.context.line(`${name}::Url(..) => "an instance of URL".to_owned(),`);
    this.context.line(`${name}::Bytes(..) => "an instance of Uint8Array".to_owned(),`);
    this.context.line(`${name}::TypedBytes(value) => format!("an instance of {}", runtime::typed_bytes_name(value)),`);
    this.context.line(`${name}::Buffer(..) => "an instance of Buffer".to_owned(),`);
    this.context.line(`${name}::NativeConstructor(name) => format!("function {name}"),`);
    this.context.line(`${name}::Array(..) => "an instance of Array".to_owned(),`);
    this.context.line(`${name}::Object(..) => "an instance of Object".to_owned(),`);
    this.context.line(`${name}::Getter(..) => "function getter".to_owned(),`);
    this.context.line(`${name}::Promise(..) => "an instance of Promise".to_owned(),`);
    this.context.line(`${name}::NetServer(..) => "an instance of Server".to_owned(),`);
    this.context.line(`${name}::NetSocket(..) => "an instance of Socket".to_owned(),`);
    this.context.line(`${name}::HttpRequest(..) => "an instance of IncomingMessage".to_owned(),`);
    this.context.line(`${name}::HttpResponse(..) => "an instance of ServerResponse".to_owned(),`);
    this.context.line(`${name}::HttpAgent(..) => "an instance of Agent".to_owned(),`);
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
    emitRustDynamicScalarChecks(this.context);

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
      const fixedParams = shape.type.restAbi === "jsval" ? shape.type.params.slice(0, -1) : shape.type.params;
      const typedArgs = fixedParams.map((param, index) => {
        const value = `args.get(${index}).cloned().unwrap_or(${name}::Undefined)`;
        return this.emitDynCheckValue(param, value);
      });
      if (shape.type.rest === true) {
        typedArgs.push(`${name}::Array(runtime::array_new(args.iter().skip(${fixedParams.length}).cloned().collect()))`);
      }
      const loc = this.context.module().functions[0]?.loc;
      if (loc === undefined) this.context.unsupported("dynamic call without a source location");
      const dispatch = this.context.emitClosureDispatch("sc_dyn_callee", shape.type, typedArgs, loc);
      const result = shape.type.ret.kind === "void" ? `{ let _ = ${dispatch}; ${name}::Undefined }` : this.emitDynFromValue(shape.type.ret, dispatch, loc);
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(closure, _, _) => { let sc_dyn_callee = closure.clone(); ${result} },`);
    }
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    if (this.context.usesDynamicInvoke()) {
      emitRustDynamicInvoke(this.context, boxedShapes);
    }
    emitRustDynamicHttp(this.context);
    emitRustDynamicAgent(this.context);
    this.emitDynamicStringCoercion(boxedShapes);
    this.emitDynamicErrorAndCloneHelpers(boxedShapes);
    emitRustDynamicAssertions(this.context, boxedShapes);
    this.context.line("");
  }

  private emitDynamicStringCoercion(boxedShapes: readonly RustClosureShape[]): void {
    const name = this.context.dynTypeName();
    const callable = boxedShapes
      .map((shape) => `${name}::${this.context.dynFunctionVariant(shape)}(..)`)
      .join(" | ");
    this.context.line(`fn sc_dyn_string_coerce_hook(receiver: &${name}, method: &${name}, method_name: &str) -> Option<runtime::JsString> {`);
    this.context.pushIndent();
    this.context.line("let result = match method {");
    this.context.pushIndent();
    if (callable.length > 0) {
      const thisBinding = this.context.usesDynamicInvoke()
        ? "let _this_guard = sc_dyn_this_push(receiver.clone());"
        : "let _ = receiver;";
      this.context.line(`${callable} => { ${thisBinding} sc_dyn_call(method, &[], method_name) },`);
    }
    this.context.line("_ => return None,");
    this.context.popIndent();
    this.context.line("};");
    this.context.line(`match &result { ${name}::Undefined | ${name}::Null | ${name}::Number(..) | ${name}::Boolean(..) | ${name}::String(..) => Some(sc_dyn_to_string(&result)), _ => None, }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_string_coerce_js(value: &${name}) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line(`let ${name}::Object(object) = value else { return sc_dyn_to_string(value); };`);
    this.context.line(`if let Some(to_string) = runtime::map_get_by(object, &runtime::string("toString"), |left, right| left.as_ref() == right.as_ref()) { if let Some(result) = sc_dyn_string_coerce_hook(value, &to_string, "toString") { return result; } } else if !sc_dyn_is_null_proto(object) { return runtime::string("[object Object]"); }`);
    this.context.line("if let Some(value_of) = runtime::map_get_by(object, &runtime::string(\"valueOf\"), |left, right| left.as_ref() == right.as_ref()) { if let Some(result) = sc_dyn_string_coerce_hook(value, &value_of, \"valueOf\") { return result; } }");
    this.context.line("runtime::throw_type_error(\"Cannot convert object to primitive value\".to_owned())");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_strict_equal(left: &${name}, right: &${name}) -> bool { match (left, right) { (${name}::Number(left), ${name}::Number(right)) => left == right, (${name}::Promise(left), ${name}::Promise(right)) => runtime::promise_handle_identity(left) == runtime::promise_handle_identity(right), _ => sc_dyn_equal(left, right, false), } }`);
  }

  emitDynamicErrorAndCloneHelpers(boxedShapes: readonly RustClosureShape[]): void {
    const name = this.context.dynTypeName();
    const mapType = `runtime::JsMap<runtime::JsString, ${name}>`;
    const errorType = this.context.errorClassRoots().length === 0 ? "runtime::JsError" : this.context.errorValueName();
    const errorHelper = (helper: string): string => this.context.errorClassRoots().length === 0 ? `runtime::error_${helper}` : `sc_error_${helper}`;

    this.context.line("std::thread_local! {");
    this.context.pushIndent();
    this.context.line(`static SC_DYN_ERROR_CACHE: std::cell::RefCell<Vec<(usize, ${errorType}, ${mapType})>> = const { std::cell::RefCell::new(Vec::new()) };`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_error_box(error: &${errorType}) -> ${name} {`);
    this.context.pushIndent();
    this.context.line(`let identity = ${errorHelper("identity")}(error);`);
    this.context.line("if let Some(object) = SC_DYN_ERROR_CACHE.with(|cache| cache.borrow().iter().find(|(cached, _, _)| *cached == identity).map(|(_, _, object)| object.clone())) {");
    this.context.pushIndent();
    this.context.line(`return ${name}::Object(object);`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`let object: ${mapType} = runtime::map_new();`);
    this.context.line("SC_DYN_ERROR_CACHE.with(|cache| cache.borrow_mut().push((identity, error.clone(), object.clone())));");
    this.context.line(`runtime::map_set_by(&object, runtime::string("%error"), ${name}::Boolean(true), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line(`runtime::map_set_by(&object, runtime::string("name"), ${name}::String(${errorHelper("name")}(error)), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line(`runtime::map_set_by(&object, runtime::string("message"), ${name}::String(${errorHelper("message")}(error)), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line(`if ${errorHelper("is_class")}(error, "DOMException") {`);
    this.context.pushIndent();
    this.context.line(`runtime::map_set_by(&object, runtime::string("code"), ${name}::Number(${errorHelper("dom_code")}(error)), |left, right| left.as_ref() == right.as_ref());`);
    this.context.line(`if let Some(cause) = ${errorHelper("dom_cause")}::<${name}>(error) { runtime::map_set_by(&object, runtime::string("cause"), cause, |left, right| left.as_ref() == right.as_ref()); }`);
    this.context.popIndent();
    this.context.line(`} else if let Some(code) = ${errorHelper("code")}(error) {`);
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
    this.context.line(`SC_DYN_ERROR_CACHE.with(|cache| cache.borrow().iter().find(|(_, _, cached)| cached.identity() == identity).is_some_and(|(_, error, _)| ${errorHelper("is_class")}(error, target)))`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_error_unbox(value: ${name}) -> ${errorType} {`);
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
    this.context.line(`${name}::Regex(value) => ${name}::Regex(runtime::regex_new(&runtime::regex_source(value), &runtime::regex_flags(value))),`);
    this.context.line(`${name}::Url(value) => ${name}::Url(value.clone()),`);
    this.context.line(`${name}::Bytes(value) => ${name}::Bytes(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::TypedBytes(value) => ${name}::TypedBytes(runtime::typed_bytes_copy(value)),`);
    this.context.line(`${name}::Buffer(value) => ${name}::Buffer(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::NativeConstructor(name) => ${name}::NativeConstructor(name),`);
    this.context.line(`${name}::Getter(..) => runtime::throw_dom_exception("DataCloneError", "getter could not be cloned."),`);
    this.context.line(`${name}::Promise(..) => runtime::throw_dom_exception("DataCloneError", "#<Promise> could not be cloned."),`);
    this.context.line(`${name}::NetServer(..) => runtime::throw_dom_exception("DataCloneError", "#<Server> could not be cloned."),`);
    this.context.line(`${name}::NetSocket(..) => runtime::throw_dom_exception("DataCloneError", "#<Socket> could not be cloned."),`);
    this.context.line(`${name}::HttpRequest(..) => runtime::throw_dom_exception("DataCloneError", "#<IncomingMessage> could not be cloned."),`);
    this.context.line(`${name}::HttpResponse(..) => runtime::throw_dom_exception("DataCloneError", "#<ServerResponse> could not be cloned."),`);
    this.context.line(`${name}::HttpAgent(..) => runtime::throw_dom_exception("DataCloneError", "#<Agent> could not be cloned."),`);
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
    this.context.line(`(${name}::Regex(left), ${name}::Regex(right)) => std::rc::Rc::ptr_eq(left, right),`);
    this.context.line(`(${name}::Url(left), ${name}::Url(right)) => std::rc::Rc::ptr_eq(left, right),`);
    this.context.line(`(${name}::NetServer(left), ${name}::NetServer(right)) => left.ptr_eq(right),`);
    this.context.line(`(${name}::NetSocket(left), ${name}::NetSocket(right)) => left.ptr_eq(right),`);
    this.context.line(`(${name}::HttpRequest(left), ${name}::HttpRequest(right)) => left.ptr_eq(right),`);
    this.context.line(`(${name}::HttpResponse(left), ${name}::HttpResponse(right)) => left.ptr_eq(right),`);
    this.context.line(`(${name}::HttpAgent(left), ${name}::HttpAgent(right)) => left.ptr_eq(right),`);
    this.context.line(`(${name}::Bytes(left), ${name}::Bytes(right)) => {`);
    this.context.pushIndent();
    this.context.line("if left.ptr_eq(right) { true } else if !deep || runtime::bytes_len(left) != runtime::bytes_len(right) { false } else {");
    this.context.pushIndent();
    this.context.line("let mut index = 0.0; let mut equal = true; while equal && index < runtime::bytes_len(left) { equal = runtime::bytes_get(left, index) == runtime::bytes_get(right, index); index += 1.0; } equal");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`(${name}::TypedBytes(left), ${name}::TypedBytes(right)) => runtime::typed_bytes_ptr_eq(left, right) || (deep && runtime::typed_bytes_deep_equals(left, right)),`);
    this.context.line(`(${name}::Buffer(left), ${name}::Buffer(right)) => left.ptr_eq(right) || (deep && runtime::bytes_deep_equals(left, right)),`);
    this.context.line(`(${name}::NativeConstructor(left), ${name}::NativeConstructor(right)) => left == right,`);
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
    this.context.line("if sc_dyn_is_null_proto(left) != sc_dyn_is_null_proto(right) { false } else if left.ptr_eq(right) { true } else if !deep || runtime::map_size(left) != runtime::map_size(right) { false } else {");
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

  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName = "", liveRef = false): string {
    return this.dynFrom.emit(type, value, loc, functionName, liveRef);
  }

  emitDynFromDefinitions(): void {
    this.dynFrom.emitDefinitions();
  }

  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string {
    switch (type.kind) {
      case "dyn": case "jsval": return value;
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
      case "httpReq": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::HttpRequest(request) => request, value => sc_dyn_check_fail("IncomingMessage", &value), } }`;
      }
      case "httpRes": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::HttpResponse(response) => response, value => sc_dyn_check_fail("ServerResponse", &value), } }`;
      }
      case "func": return `${this.context.dynFunctionCheckName(this.context.closureShapeForType(type, loc))}(${value})`;
      case "object": {
        if (!RUNTIME_ERROR_CLASSES.has(type.className)) {
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
