import { emitRustDynamicKindQueries } from "./dynamic-kind.js";
import { sharedDiscriminatedUnion, discriminatedUnionCheck } from "./discriminated-records.js";
import { emitNativeUnionCheck } from "./native-union-check.js";
import { emitNativeMapCheck } from "./native-map-values.js";
import { nativeArrayViewSupported, nativeIndexedRecordValue } from "../../ir/native-record.js";
import { emitNativeArrayCheck } from "./native-array-values.js";
import { emitRustDynamicEquality } from "./dynamic-equality.js";
import { emitRustDynamicIslandSupport } from "./dynamic-island.js";
import type { IrType, SrcLoc } from "../../ir/ir.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/ir.js";
import { emitRustDynamicInvoke } from "./dynamic-invoke.js";
import { emitRustDynamicWebStream } from "./dynamic-web-stream.js";
import { emitRustDynamicHttp } from "./dynamic-http.js";
import { emitRustDynamicAgent } from "./dynamic-agent.js";
import { emitRustDynamicAssertions } from "./dynamic-assertions.js";
import { emitRustDynamicInspect } from "./dynamic-inspect.js";
import { emitRustDynamicScalarChecks } from "./dynamic-scalars.js";
import { emitRustDynamicJsonReplacer } from "./dynamic-json-replacer.js";
import { emitRustDynamicStringCoercion } from "./dynamic-string-coercion.js";
import { RustDynamicFromEmitter } from "./dynamic-from.js";
import { emitRustDynamicObjectWalk } from "./dynamic-object-walk.js";
import { emitRustDynamicObjectPrototype } from "./dynamic-object-prototype.js";
import { emitRustNativeMethodDefinition } from "./dynamic-native-method.js";
import { emitRustQuerystringDynImpl } from "./querystring.js";
import type { RustDynamicContext } from "./dynamic-context.js";
import type { RustClosureShape } from "./model.js";
import { isSharedRecord, recordCheckName } from "./shared-records.js";

export class RustDynamicEmitter {
  private readonly dynFrom: RustDynamicFromEmitter;

  constructor(private readonly context: RustDynamicContext) {
    this.dynFrom = new RustDynamicFromEmitter(context, (type, value, loc) => this.emitDynCheckValue(type, value, loc));
  }

  emitDynamicDefinition(): void {
    if (!this.context.usesDyn()) return;
    const name = this.context.dynTypeName();
    const usesEmbeddedModules = this.context.hasEmbeddedModules();
    const caughtErrorTest = this.context.errorClassRoots().length === 0 ? "runtime::caught_is_error(&caught)" : "sc_caught_is_error_class(&caught, \"Error\")";
    const caughtErrorValue = this.context.errorClassRoots().length === 0 ? "runtime::caught_error_value(&caught)" : "sc_caught_error_value(&caught)";
    const boxedShapes = [...this.context.dynBoxedFunctionShapes].map((key) => {
      const shape = this.context.closureShapes.get(key);
      if (shape === undefined) this.context.unsupported(`dynamic function signature '${key}'`);
      return shape;
    });

    emitRustNativeMethodDefinition(this.context);
    this.context.line("#[derive(Clone)]");
    this.context.line(`enum ${name} {`);
    this.context.pushIndent();
    this.context.line("Undefined,");
    this.context.line("Null,");
    this.context.line("Number(f64),");
    this.context.line("BigInt(runtime::JsBigInt),");
    this.context.line("Date(runtime::JsDate),");
    this.context.line("Effect(runtime::JsEffect),");
    this.context.line("Boolean(bool),");
    this.context.line("String(runtime::JsString),");
    this.context.line("Regex(runtime::JsRegex),");
    this.context.line("Url(runtime::JsUrl),");
    this.context.line("Bytes(runtime::JsBytes<u8>),");
    this.context.line("TypedBytes(runtime::JsTypedBytes),");
    this.context.line("Buffer(runtime::JsBytes<u8>),");
    this.context.line("NativeConstructor(&'static str),");
    this.context.line("NativeMethod(ScDynNativeMethod),");
    this.context.line("Promise(runtime::JsPromiseHandle),");
    this.context.line("NetServer(runtime::JsNetServer),");
    this.context.line("NetSocket(runtime::JsNetSocket),");
    this.context.line(`AbortController(runtime::JsAbortSignal<${name}>), AbortSignal(runtime::JsAbortSignal<${name}>), HttpRequest(runtime::JsHttpRequest),`);
    this.context.line("HttpHeaders(runtime::JsHttpRequest),");
    this.context.line("FetchBody(runtime::JsHttpRequest),");
    this.context.line("FetchReader(runtime::JsFetchReader),");
    this.context.line(`WebStream(runtime::JsWebStream<${name}>), WebController(runtime::JsWebStream<${name}>), WebReader(runtime::JsWebReader<${name}>),`);
    this.context.line("HttpResponse(runtime::JsHttpResponse),");
    this.context.line("HttpAgent(runtime::JsHttpAgent),");
    if (usesEmbeddedModules) this.context.line("Island(runtime::IslandValue),");
    this.context.line(`Array(runtime::JsArray<${name}>),`);
    this.context.line(`ArrayIterator(runtime::JsArrayIterator<${name}>),`);
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
    this.context.line("Self::ArrayIterator(value) => tracer.edge(value),");
    this.context.line("Self::Object(value) => tracer.edge(value),");
    this.context.line("Self::Effect(value) => tracer.edge(value),");
    this.context.line("Self::Getter(value) => runtime::Trace::trace(value.as_ref(), tracer),");
    this.context.line("Self::Bytes(value) => tracer.edge(value),");
    this.context.line("Self::TypedBytes(value) => runtime::typed_bytes_trace(value, tracer),");
    this.context.line("Self::Buffer(value) => tracer.edge(value),");
    this.context.line("Self::Promise(value) => runtime::promise_handle_trace(value, tracer),");
    this.context.line("Self::NetServer(value) => tracer.edge(value),");
    this.context.line("Self::NetSocket(value) => tracer.edge(value),");
    this.context.line("Self::AbortController(value) | Self::AbortSignal(value) => tracer.edge(value), Self::HttpRequest(value) => tracer.edge(value),");
    this.context.line("Self::HttpHeaders(value) => tracer.edge(value),");
    this.context.line("Self::FetchBody(value) => tracer.edge(value),");
    this.context.line("Self::FetchReader(value) => tracer.edge(value),");
    this.context.line("Self::WebStream(value) | Self::WebController(value) => tracer.edge(value), Self::WebReader(value) => tracer.edge(value),");
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
    this.context.line(`fn sc_dyn_effect_reflection<T>(operation: &str) -> T { runtime::throw_error(format!("scriptc: {} on native kernel references is not supported yet", operation)) }`);
    emitRustQuerystringDynImpl(name, this.context);
    emitRustDynamicIslandSupport(this.context);
    this.context.line(`impl runtime::JsonValue for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn write_json(&self, writer: &mut runtime::JsonWriter) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined | ${name}::Null => writer.write_null(),`);
    this.context.line(`${name}::Number(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::BigInt(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Date(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("JSON.stringify"),`);
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
    this.context.line(`${name}::ArrayIterator(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::Object(value) if runtime::map_is_module_namespace(value) => runtime::json_write_map_with(value, writer, |key, _| sc_dyn_object_key_get(value, key, self)),`);
    this.context.line(`${name}::Object(value) => runtime::JsonValue::write_json(value, writer),`);
    this.context.line(`${name}::Getter(..) => writer.write_null(),`);
    this.context.line(`${name}::Promise(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::NetServer(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::NetSocket(..) => { writer.begin_object(); writer.end_object(); },`);
    this.context.line(`${name}::AbortController(..) | ${name}::AbortSignal(..) | ${name}::HttpRequest(..) | ${name}::HttpHeaders(..) | ${name}::FetchBody(..) | ${name}::FetchReader(..) | ${name}::WebStream(..) | ${name}::WebController(..) | ${name}::WebReader(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => { writer.begin_object(); writer.end_object(); },`);
    if (usesEmbeddedModules) {
      this.context.line(`${name}::Island(value) => runtime::JsonValue::write_json(&runtime::island_json_node(value), writer),`);
    }
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(..) => writer.write_null(),`);
    }
    this.context.line(`${name}::NativeConstructor(..) | ${name}::NativeMethod(..) => writer.write_null(),`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn is_json_undefined(&self) -> bool {");
    this.context.pushIndent();
    const undefinedPatterns = [
      `${name}::Undefined`,
      `${name}::NativeConstructor(..)`,
      `${name}::NativeMethod(..)`,
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
    this.context.line(`${name}::BigInt(value) => runtime::display_bigint(value),`);
    this.context.line(`${name}::Date(value) => runtime::date_value_inspect(value).to_string(),`);
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
    this.context.line(`fn sc_dyn_deep_copy_array(value: &runtime::JsArray<${name}>) -> runtime::JsArray<${name}> {`);
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
    this.context.line("if let Some(raw) = runtime::array_raw(value) {");
    this.context.pushIndent();
    this.context.line("runtime::array_set_raw(&output, sc_dyn_deep_copy_array(&raw));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("output");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_deep_copy(value: &${name}) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => ${name}::Undefined,`);
    this.context.line(`${name}::Null => ${name}::Null,`);
    this.context.line(`${name}::Number(value) => ${name}::Number(*value),`);
    this.context.line(`${name}::BigInt(value) => ${name}::BigInt(value.clone()),`);
    this.context.line(`${name}::Date(value) => ${name}::Date(value.clone()),`);
    this.context.line(`${name}::Effect(value) => ${name}::Effect(value.clone()),`);
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
    this.context.line(`${name}::AbortController(value) => ${name}::AbortController(value.clone()), ${name}::AbortSignal(value) => ${name}::AbortSignal(value.clone()), ${name}::HttpRequest(value) => ${name}::HttpRequest(value.clone()),`);
    this.context.line(`${name}::HttpHeaders(value) => ${name}::HttpHeaders(value.clone()),`);
    this.context.line(`${name}::FetchBody(value) => ${name}::FetchBody(value.clone()),`);
    this.context.line(`${name}::WebStream(value) => ${name}::WebStream(value.clone()),`);
    this.context.line(`${name}::WebController(value) => ${name}::WebController(value.clone()),`);
    this.context.line(`${name}::WebReader(value) => ${name}::WebReader(value.clone()),`);
    this.context.line(`${name}::FetchReader(value) => ${name}::FetchReader(value.clone()),`);
    this.context.line(`${name}::HttpResponse(value) => ${name}::HttpResponse(value.clone()),`);
    this.context.line(`${name}::HttpAgent(value) => ${name}::HttpAgent(value.clone()),`);
    this.context.line(`${name}::Array(value) => ${name}::Array(sc_dyn_deep_copy_array(value)),`);
    this.context.line(`${name}::ArrayIterator(value) => ${name}::ArrayIterator(value.clone()),`);
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
    this.context.line(`${name}::NativeMethod(method) => ${name}::NativeMethod(*method),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(value) => ${name}::Island(value.clone()),`);
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
    this.context.line(`${name}::BigInt(..) => Err(format!("bigint at {path} is not JSON data")),`);
    this.context.line(`${name}::Date(..) => Err(format!("Date at {path} is not JSON data")),`);
    this.context.line(`${name}::Effect(..) => Err(format!("native kernel reference at {path} is not JSON data")),`);
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
    this.context.line(`${name}::AbortController(..) | ${name}::AbortSignal(..) | ${name}::HttpRequest(..) | ${name}::HttpHeaders(..) | ${name}::FetchBody(..) | ${name}::FetchReader(..) | ${name}::WebStream(..) | ${name}::WebController(..) | ${name}::WebReader(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
    this.context.line(`${name}::ArrayIterator(..) => Ok(runtime::JsonNode::Object(Vec::new())),`);
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
    this.context.line("fields.push((key.clone(), sc_dyn_to_json(&field, &field_path)?));");
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
    this.context.line(`${name}::NativeConstructor(..) | ${name}::NativeMethod(..) => Err(format!("function at {path} is not JSON data")),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(value) => Ok(runtime::island_json_node(value)),`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");

    emitRustDynamicKindQueries(this.context, boxedShapes);
    this.context.line(`fn sc_dyn_from_caught(caught: runtime::Caught) -> ${name} {`);
    this.context.pushIndent();
    this.context.line(`if runtime::caught_is::<${name}>(&caught) { runtime::caught_narrow::<${name}>(&caught) }`);
    this.context.line(`else if runtime::caught_is::<runtime::JsEffect>(&caught) { ${name}::Effect(runtime::caught_narrow::<runtime::JsEffect>(&caught)) }`);
    this.context.line(`else if runtime::caught_is::<f64>(&caught) { ${name}::Number(runtime::caught_narrow::<f64>(&caught)) }`);
    this.context.line(`else if runtime::caught_is::<bool>(&caught) { ${name}::Boolean(runtime::caught_narrow::<bool>(&caught)) }`);
    this.context.line(`else if runtime::caught_is::<runtime::JsString>(&caught) { ${name}::String(runtime::caught_narrow::<runtime::JsString>(&caught)) }`);
    if (usesEmbeddedModules) this.context.line("else if runtime::caught_is::<runtime::IslandValue>(&caught) { sc_dyn_from_island(runtime::caught_narrow::<runtime::IslandValue>(&caught)) }");
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
    this.context.line(`fn sc_dyn_has_key(value: &${name}, key: &runtime::JsString) -> bool {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("property membership"),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(value) => sc_dyn_island_has(value, key, false),`);
    this.context.line(`${name}::Object(object) => runtime::map_has_by(object, key, |left, right| left.as_ref() == right.as_ref()) || runtime::map_prototype(object).is_some_and(|prototype| sc_dyn_has_key(&prototype, key)),`);
    this.context.line(`${name}::Array(array) => key.as_ref() == "length" || sc_dyn_key_index(key).is_some_and(|index| index < runtime::array_len(array) as usize),`);
    this.context.line("_ => false,");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_has_own(value: &${name}, key: &runtime::JsString) -> bool {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("own property membership"),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(value) => sc_dyn_island_has(value, key, true),`);
    this.context.line(`${name}::Undefined | ${name}::Null => runtime::throw_type_error("Cannot convert undefined or null to object".to_owned()),`);
    this.context.line(`${name}::Object(object) => runtime::map_has_by(object, key, |left, right| left.as_ref() == right.as_ref()),`);
    this.context.line(`${name}::Array(array) => key.as_ref() == "length" || (key.as_ref() == "raw" && runtime::array_raw(array).is_some()) || sc_dyn_key_index(key).is_some_and(|index| index < runtime::array_len(array) as usize),`);
    this.context.line("_ => false,");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    const getterRead = this.context.usesDynamicInvoke()
      ? `{ let _this_guard = sc_dyn_this_push(receiver.clone()); sc_dyn_call(getter.as_ref(), &[], key.as_ref()) }`
      : "sc_dyn_call(getter.as_ref(), &[], key.as_ref())";
    emitRustDynamicObjectPrototype(this.context);
    this.context.line(`fn sc_dyn_object_key_get(object: &runtime::JsMap<runtime::JsString, ${name}>, key: &runtime::JsString, receiver: &${name}) -> ${name} {`);
    this.context.pushIndent();
    this.context.line(`match runtime::map_get_by(object, key, |left, right| left.as_ref() == right.as_ref()) { Some(${name}::Getter(getter)) => ${getterRead}, Some(field) => field, None => match runtime::map_prototype(object) { Some(${name}::Object(prototype)) => sc_dyn_object_key_get(&prototype, key, receiver), None => sc_dyn_object_prototype_fallback(object, key), _ => ${name}::Undefined, }, }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_key_get(value: &${name}, key: &runtime::JsString, optional: bool) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    if (usesEmbeddedModules) this.context.line(`${name}::Island(value) => sc_dyn_from_island(runtime::island_get_index(value, &runtime::island_value_string(key))),`);
    this.context.line(`${name}::Undefined | ${name}::Null => {`);
    this.context.pushIndent();
    this.context.line(`if optional { return ${name}::Undefined; }`);
    this.context.line(`runtime::throw_type_error(format!("Cannot read properties of {} (reading '{}')", sc_dyn_kind(value), key))`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(object) => sc_dyn_object_key_get(object, key, value),`);
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("property access"),`);
    this.context.line(`${name}::Number(..) => match key.to_utf8_lossy() { "toString" => ${name}::NativeMethod(ScDynNativeMethod::NumberToString), "toFixed" => ${name}::NativeMethod(ScDynNativeMethod::NumberToFixed), _ => ${name}::Undefined, },`);
    this.context.line(`${name}::Regex(regex) => match key.to_utf8_lossy() { "source" => ${name}::String(runtime::regex_source(regex)), "flags" => ${name}::String(runtime::regex_flags(regex)), "lastIndex" => ${name}::Number(runtime::regex_last_index(regex)), _ => ${name}::Undefined, },`);
    this.context.line(`${name}::Url(url) => match key.to_utf8_lossy() { "href" => ${name}::String(runtime::url_href(url)), "protocol" => ${name}::String(runtime::url_protocol(url)), "host" => ${name}::String(runtime::url_host(url)), "hostname" => ${name}::String(runtime::url_hostname(url)), "pathname" => ${name}::String(runtime::url_pathname(url)), "port" => ${name}::String(runtime::url_port(url)), "origin" => ${name}::String(runtime::url_origin(url)), "hash" => ${name}::String(runtime::url_hash(url)), "username" => ${name}::String(runtime::url_username(url)), "password" => ${name}::String(runtime::url_password(url)), _ => ${name}::Undefined, },`);
    this.context.line(`${name}::Array(array) => {`);
    this.context.pushIndent();
    this.context.line(`if key.as_ref() == "length" { ${name}::Number(runtime::array_len(array)) }`);
    this.context.line(`else if key.as_ref() == "raw" { runtime::array_raw(array).map(${name}::Array).unwrap_or(${name}::Undefined) }`);
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
    this.context.line(`if key.as_ref() == "length" || key.as_ref() == "byteLength" { ${name}::Number(runtime::bytes_len(bytes)) }`);
    this.context.line(`else if key.as_ref() == "constructor" { ${name}::NativeConstructor(if matches!(value, ${name}::Buffer(..)) { "Buffer" } else { "Uint8Array" }) }`);
    this.context.line(`else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::bytes_len(bytes) as usize { ${name}::Number(runtime::bytes_get(bytes, index as f64)) } else { ${name}::Undefined } }`);
    this.context.line(`else { ${name}::Undefined }`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::TypedBytes(bytes) => { if key.as_ref() == "length" { ${name}::Number(runtime::typed_bytes_len(bytes)) } else if key.as_ref() == "byteLength" { ${name}::Number(runtime::typed_bytes_byte_len(bytes)) } else if key.as_ref() == "constructor" { ${name}::NativeConstructor(runtime::typed_bytes_name(bytes)) } else if let Some(index) = sc_dyn_key_index(key) { if index < runtime::typed_bytes_len(bytes) as usize { ${name}::Number(runtime::typed_bytes_get(bytes, index as f64)) } else { ${name}::Undefined } } else { ${name}::Undefined } },`);
    this.context.line(`${name}::NativeConstructor(name) => if key.as_ref() == "name" { ${name}::String(runtime::string(name)) } else { ${name}::Undefined },`);
    this.context.line(`${name}::NativeMethod(method) => if key.as_ref() == "name" { ${name}::String(runtime::string(method.name())) } else { ${name}::Undefined },`);
    this.context.line(`${name}::NetSocket(socket) => match key.to_utf8_lossy() {`);
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
    this.context.line(`${name}::AbortController(signal) => if key.as_ref() == "signal" { ${name}::AbortSignal(signal.clone()) } else { ${name}::Undefined }, ${name}::AbortSignal(signal) => match key.to_utf8_lossy() { "aborted" => ${name}::Boolean(runtime::abort_signal_aborted(signal)), "reason" => runtime::abort_signal_reason(signal).unwrap_or(${name}::Undefined), _ => ${name}::Undefined, }, ${name}::HttpRequest(request) => sc_dyn_http_request_get(request, key),`);
    this.context.line(`${name}::HttpHeaders(..) => ${name}::Undefined,`);
    this.context.line(`${name}::FetchBody(request) => if key.as_ref() == "locked" { ${name}::Boolean(runtime::fetch_body_locked(request)) } else { ${name}::Undefined },`);
    this.context.line(`${name}::FetchReader(..) => ${name}::Undefined,`);
    this.context.line(`${name}::WebReader(reader) => if key.as_ref() == "closed" { ${name}::Promise(runtime::promise_to_mapped_handle(&runtime::web_reader_closed(reader), |_| ${name}::Undefined)) } else { ${name}::Undefined },`);
    this.context.line(`${name}::WebStream(stream) => if key.as_ref() == "locked" { ${name}::Boolean(runtime::web_stream_locked(stream)) } else { ${name}::Undefined },`);
    this.context.line(`${name}::WebController(stream) => if key.as_ref() == "desiredSize" { runtime::web_stream_desired_size(stream).map(${name}::Number).unwrap_or(${name}::Null) } else { ${name}::Undefined },`);
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
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("property assignment"),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(value) => runtime::island_set_index(value, &runtime::island_value_string(&key), &sc_dyn_to_island(&field)),`);
    this.context.line(`${name}::Object(object) => { if runtime::map_is_module_namespace(object) { if runtime::map_has_by(object, &key, |left, right| left.as_ref() == right.as_ref()) { runtime::throw_type_error(format!("Cannot assign to read only property '{}' of object '[object Module]'", key)); } runtime::throw_type_error(format!("Cannot add property {}, object is not extensible", key)); } runtime::map_set_by(object, key, field, |left, right| left.as_ref() == right.as_ref()); },`);
    this.context.line(`${name}::Regex(regex) if key.as_ref() == "lastIndex" => match field { ${name}::Number(value) => runtime::regex_set_last_index(regex, value), _ => runtime::regex_set_last_index(regex, 0.0), },`);
    this.context.line(`${name}::Array(array) => {`);
    this.context.pushIndent();
    this.context.line("let Some(index) = sc_dyn_key_index(&key) else { sc_dyn_key_set_error(value, &key); };");
    this.context.line(`while runtime::array_len(array) < index as f64 { runtime::array_push(array, ${name}::Undefined); }`);
    this.context.line("runtime::array_set(array, index as f64, field);");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Bytes(bytes) | ${name}::Buffer(bytes) => {`);
    this.context.pushIndent();
    this.context.line("let Some(index) = sc_dyn_key_index(&key) else { sc_dyn_key_set_error(value, &key); };");
    this.context.line("runtime::bytes_set(bytes, index as f64, sc_dyn_to_number(&field));");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::TypedBytes(bytes) => { let Some(index) = sc_dyn_key_index(&key) else { sc_dyn_key_set_error(value, &key); }; runtime::typed_bytes_set(bytes, index as f64, sc_dyn_to_number(&field)); },`);
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
    this.context.line(`if matches!(value, ${name}::BigInt(..)) { runtime::throw_type_error(if runtime::target_runtime_id() == "bun" { "Conversion from 'BigInt' to 'number' is not allowed." } else { "Cannot convert a BigInt value to a number" }.to_owned()); }`);
    this.context.pushIndent();
    this.context.line(`match value { ${name}::Date(value) => runtime::date_value_time(value), ${name}::Undefined => f64::NAN, ${name}::Null => 0.0, ${name}::Number(value) => *value, ${name}::Boolean(value) => if *value { 1.0 } else { 0.0 }, ${name}::String(value) => runtime::number_from_string(value), _ => runtime::number_from_string(&sc_dyn_to_string(value)), }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_to_string(value: &${name}) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => runtime::string("undefined"),`);
    this.context.line(`${name}::Null => runtime::string("null"),`);
    this.context.line(`${name}::Number(value) => runtime::number_to_string(*value),`);
    this.context.line(`${name}::BigInt(value) => runtime::bigint_to_string(value),`);
    this.context.line(`${name}::Date(value) => runtime::date_value_to_string(value),`);
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("string coercion"),`);
    this.context.line(`${name}::Boolean(value) => runtime::string(&runtime::display_bool(*value)),`);
    this.context.line(`${name}::String(value) => value.clone(),`);
    this.context.line(`${name}::Regex(value) => runtime::string(&format!("/{}/{}", runtime::regex_source(value), runtime::regex_flags(value))),`);
    this.context.line(`${name}::Url(value) => runtime::url_href(value),`);
    this.context.line(`${name}::Bytes(value) => runtime::bytes_join(value, &runtime::string(",")),`);
    this.context.line(`${name}::TypedBytes(value) => runtime::typed_bytes_join(value, &runtime::string(",")),`);
    this.context.line(`${name}::Buffer(value) => runtime::bytes_to_string(value, &runtime::string("utf8")),`);
    this.context.line(`${name}::NativeConstructor(name) => runtime::string(&format!("function {name}() {{ [native code] }}")),`);
    this.context.line(`${name}::NativeMethod(method) => runtime::string(&format!("function {}() {{ [native code] }}", method.name())),`);
    this.context.line(`${name}::Promise(..) => runtime::string("[object Promise]"),`);
    this.context.line(`${name}::NetServer(..) => runtime::string("[object Object]"),`);
    this.context.line(`${name}::NetSocket(..) => runtime::string("[object Object]"),`);
    this.context.line(`${name}::AbortController(..) | ${name}::AbortSignal(..) | ${name}::HttpRequest(..) | ${name}::HttpHeaders(..) | ${name}::FetchBody(..) | ${name}::FetchReader(..) | ${name}::WebStream(..) | ${name}::WebController(..) | ${name}::WebReader(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..) => runtime::string("[object Object]"),`);
    this.context.line(`${name}::Array(value) => {`);
    this.context.pushIndent();
    this.context.line("let mut output = runtime::JsStringBuilder::new();");
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
    this.context.line(`${name}::ArrayIterator(..) => runtime::string("[object Array Iterator]"),`);
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
    if (usesEmbeddedModules) this.context.line(`${name}::Island(value) => runtime::island_to_string(value),`);
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
    this.context.line(`${name}::BigInt(value) => format!("type bigint ({})", runtime::display_bigint(value)),`);
    this.context.line(`${name}::Date(value) => format!("an instance of Date ({})", runtime::date_value_inspect(value)),`);
    this.context.line(`${name}::Boolean(value) => format!("type boolean ({value})"),`);
    this.context.line(`${name}::String(value) => runtime::dynamic_specific_string(value),`);
    this.context.line(`${name}::Regex(..) => "an instance of RegExp".to_owned(),`);
    this.context.line(`${name}::Url(..) => "an instance of URL".to_owned(),`);
    this.context.line(`${name}::Bytes(..) => "an instance of Uint8Array".to_owned(),`);
    this.context.line(`${name}::TypedBytes(value) => format!("an instance of {}", runtime::typed_bytes_name(value)),`);
    this.context.line(`${name}::Buffer(..) => "an instance of Buffer".to_owned(),`);
    this.context.line(`${name}::NativeConstructor(name) => format!("function {name}"),`);
    this.context.line(`${name}::NativeMethod(method) => format!("function {}", method.name()),`);
    this.context.line(`${name}::Array(..) => "an instance of Array".to_owned(),`);
    this.context.line(`${name}::ArrayIterator(..) => "an instance of Array Iterator".to_owned(),`);
    this.context.line(`${name}::Object(..) => "an instance of Object".to_owned(),`);
    this.context.line(`${name}::Getter(..) => "function getter".to_owned(),`);
    this.context.line(`${name}::Promise(..) => "an instance of Promise".to_owned(),`);
    this.context.line(`${name}::Effect(..) => "a native kernel reference".to_owned(),`);
    this.context.line(`${name}::NetServer(..) => "an instance of Server".to_owned(),`);
    this.context.line(`${name}::NetSocket(..) => "an instance of Socket".to_owned(),`);
    this.context.line(`${name}::AbortController(..) => "an instance of AbortController".to_owned(), ${name}::AbortSignal(..) => "an instance of AbortSignal".to_owned(), ${name}::HttpRequest(..) => "an instance of IncomingMessage".to_owned(),`);
    this.context.line(`${name}::HttpHeaders(..) => "an instance of Headers".to_owned(),`);
    this.context.line(`${name}::FetchBody(..) => "an instance of ReadableStream".to_owned(),`);
    this.context.line(`${name}::WebStream(..) => "an instance of ReadableStream".to_owned(),`);
    this.context.line(`${name}::WebController(..) => "an instance of ReadableStreamDefaultController".to_owned(),`);
    this.context.line(`${name}::WebReader(..) => "an instance of ReadableStreamDefaultReader".to_owned(),`);
    this.context.line(`${name}::FetchReader(..) => "an instance of ReadableStreamDefaultReader".to_owned(),`);
    this.context.line(`${name}::HttpResponse(..) => "an instance of ServerResponse".to_owned(),`);
    this.context.line(`${name}::HttpAgent(..) => "an instance of Agent".to_owned(),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(..) => "an embedded JavaScript value".to_owned(),`);
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
    this.context.line(`${name}::Effect(value) if runtime::effect_reference_typeof(value) == "function" => Some(value.identity()),`);
    for (const shape of boxedShapes) {
      this.context.line(`${name}::${this.context.dynFunctionVariant(shape)}(closure, _, _) => Some(sc_closure_identity_${shape.index}(closure)),`);
    }
    this.context.line(`${name}::NativeMethod(method) => Some(method.identity()),`);
    this.context.line("_ => None,");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_check_fail(expected: &str, value: &${name}) -> ! { sc_dyn_check_fail_at(expected, value, "$" ) }`);
    this.context.line(`fn sc_dyn_check_fail_at(expected: &str, value: &${name}, path: &str) -> ! {`);
    this.context.pushIndent();
    this.context.line("runtime::throw_type_error(format!(\"expected {expected} at {path}, got {}\", sc_dyn_kind(value)))");
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
      if (usesEmbeddedModules && target.type.params.every((type) => ["f64", "bool", "string"].includes(type.kind)) && ["f64", "bool", "string"].includes(target.type.ret.kind)) {
        this.context.line(`${name}::Island(value) if runtime::island_is_function(&value) => runtime::Gc::new(${this.context.closureName(target)}::DynAdapter { value: Some(${name}::Island(value)) }),`);
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
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("calling a kernel reference as a function"),`);
    for (const shape of boxedShapes) {
      const fixedParams = shape.type.restAbi === "jsval" ? shape.type.params.slice(0, -1) : shape.type.params;
      const typedArgs = fixedParams.map((param, index) => {
        let value = `args.get(${index}).cloned().unwrap_or(${name}::Undefined)`;
        if (usesEmbeddedModules && (param.kind === "array" || param.kind === "record" || param.kind === "union") &&
            this.context.isRustJsonCompatible(param)) value = `sc_dyn_typed_island_input(${value})`;
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
    this.context.line(this.context.usesDynamicInvoke()
      ? `${name}::NativeMethod(method) => sc_dyn_call_native_method(*method, args),`
      : `${name}::NativeMethod(..) => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(callee) => { let sc_args = args.iter().map(sc_dyn_to_island).collect::<Vec<_>>(); sc_dyn_from_island(runtime::island_call(callee, &sc_args)) },`);
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    if (this.context.usesDynamicInvoke()) {
      emitRustDynamicInvoke(this.context, boxedShapes);
    }
    emitRustDynamicHttp(this.context);
    emitRustDynamicWebStream(this.context);
    emitRustDynamicAgent(this.context);
    emitRustDynamicStringCoercion(this.context, boxedShapes);
    emitRustDynamicJsonReplacer(this.context);
    this.emitDynamicErrorAndCloneHelpers(boxedShapes);
    emitRustDynamicAssertions(this.context, boxedShapes);
    this.context.line("");
  }

  emitDynamicErrorAndCloneHelpers(boxedShapes: readonly RustClosureShape[]): void {
    const name = this.context.dynTypeName();
    const usesEmbeddedModules = this.context.hasEmbeddedModules();
    const mapType = `runtime::JsMap<runtime::JsString, ${name}>`;
    const errorType = this.context.errorClassRoots().length === 0 ? "runtime::JsError" : this.context.errorValueName();
    const errorHelper = (helper: string): string => this.context.errorClassRoots().length === 0 ? `runtime::error_${helper}` : `sc_error_${helper}`;
    const errorTarget = this.context.errorClassRoots().length === 0 ? "target.strip_prefix('%').unwrap_or(target)" : "target";
    const abortError = this.context.errorClassRoots().length === 0 ? `runtime::dom_exception_new(runtime::string("This operation was aborted"), runtime::string("AbortError"), None)` : `${this.context.errorValueName()}::Builtin(runtime::dom_exception_new(runtime::string("This operation was aborted"), runtime::string("AbortError"), None))`;
    const timeoutError = this.context.errorClassRoots().length === 0 ? `runtime::dom_exception_new(runtime::string("The operation was aborted due to timeout"), runtime::string("TimeoutError"), None)` : `${this.context.errorValueName()}::Builtin(runtime::dom_exception_new(runtime::string("The operation was aborted due to timeout"), runtime::string("TimeoutError"), None))`;

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
    this.context.line(`fn sc_dyn_abort_default_reason() -> ${name} { let error = ${abortError}; sc_dyn_error_box(&error) }`);
    this.context.line(`fn sc_dyn_abort_timeout_reason() -> ${name} { let error = ${timeoutError}; sc_dyn_error_box(&error) }`);
    this.context.line(`fn sc_dyn_error_instanceof(value: &${name}, target: &str) -> bool {`);
    this.context.pushIndent();
    this.context.line(`let ${name}::Object(object) = value else { return false; };`);
    this.context.line("let identity = object.identity();");
    this.context.line(`SC_DYN_ERROR_CACHE.with(|cache| cache.borrow().iter().find(|(_, _, cached)| cached.identity() == identity).is_some_and(|(_, error, _)| ${errorHelper("is_class")}(error, ${errorTarget})))`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_dyn_error_unbox(value: ${name}) -> ${errorType} {`);
    this.context.pushIndent();
    // A realm Error handle (a typed callback's `Error` parameter, the
    // rejection of an engine promise): name and message copy out.
    if (this.context.hasEmbeddedModules()) {
      const caughtErrorTest = this.context.errorClassRoots().length === 0 ? "runtime::caught_is_error(&caught)" : "sc_caught_is_error_class(&caught, \"Error\")";
      const caughtErrorValue = this.context.errorClassRoots().length === 0 ? "runtime::caught_error_value(&caught)" : "sc_caught_error_value(&caught)";
      this.context.line(`if let ${name}::Island(handle) = &value { let caught = runtime::island_exit_error(handle); if ${caughtErrorTest} { return ${caughtErrorValue}; } return sc_dyn_check_fail("Error", &value); }`);
    }
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
    this.context.line(`fn sc_dyn_clone(value: &${name}, parents: &mut Vec<usize>) -> ${name} { sc_dyn_clone_dates(value, parents, &mut Vec::new()) }`);
    this.context.line(`fn sc_dyn_clone_dates(value: &${name}, parents: &mut Vec<usize>, dates: &mut Vec<(usize, runtime::JsDate)>) -> ${name} {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Undefined => ${name}::Undefined,`);
    this.context.line(`${name}::Null => ${name}::Null,`);
    this.context.line(`${name}::Number(value) => ${name}::Number(*value),`);
    this.context.line(`${name}::BigInt(value) => ${name}::BigInt(value.clone()),`);
    this.context.line(`${name}::Date(value) => { if runtime::target_runtime_id() == \"bun\" { return ${name}::Date(runtime::date_value_copy(value)); } let id = runtime::date_value_identity(value); if let Some((_, copied)) = dates.iter().find(|(key, _)| *key == id) { ${name}::Date(copied.clone()) } else { let copied = runtime::date_value_copy(value); dates.push((id, copied.clone())); ${name}::Date(copied) } },`);
    this.context.line(`${name}::Boolean(value) => ${name}::Boolean(*value),`);
    this.context.line(`${name}::String(value) => ${name}::String(value.clone()),`);
    this.context.line(`${name}::Regex(value) => ${name}::Regex(runtime::regex_new(&runtime::regex_source(value), &runtime::regex_flags(value))),`);
    this.context.line(`${name}::Url(value) => ${name}::Url(value.clone()),`);
    this.context.line(`${name}::Bytes(value) => ${name}::Bytes(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::TypedBytes(value) => ${name}::TypedBytes(runtime::typed_bytes_copy(value)),`);
    this.context.line(`${name}::Buffer(value) => ${name}::Buffer(runtime::bytes_copy(value)),`);
    this.context.line(`${name}::NativeConstructor(name) => ${name}::NativeConstructor(name),`);
    this.context.line(`${name}::NativeMethod(method) => runtime::throw_dom_exception("DataCloneError", &format!("{} could not be cloned.", method.name())),`);
    this.context.line(`${name}::Getter(..) => runtime::throw_dom_exception("DataCloneError", "getter could not be cloned."),`);
    this.context.line(`${name}::Effect(..) => sc_dyn_effect_reflection("structuredClone"),`);
    this.context.line(`${name}::Promise(..) => runtime::throw_dom_exception("DataCloneError", "#<Promise> could not be cloned."),`);
    this.context.line(`${name}::NetServer(..) => runtime::throw_dom_exception("DataCloneError", "#<Server> could not be cloned."),`);
    this.context.line(`${name}::NetSocket(..) => runtime::throw_dom_exception("DataCloneError", "#<Socket> could not be cloned."),`);
    this.context.line(`${name}::AbortController(..) => runtime::throw_dom_exception("DataCloneError", "#<AbortController> could not be cloned."), ${name}::AbortSignal(..) => runtime::throw_dom_exception("DataCloneError", "#<AbortSignal> could not be cloned."), ${name}::HttpRequest(..) => runtime::throw_dom_exception("DataCloneError", "#<IncomingMessage> could not be cloned."),`);
    this.context.line(`${name}::HttpHeaders(..) => runtime::throw_dom_exception("DataCloneError", "#<Headers> could not be cloned."),`);
    this.context.line(`${name}::FetchBody(..) => runtime::throw_dom_exception("DataCloneError", "#<ReadableStream> could not be cloned."),`);
    this.context.line(`${name}::WebStream(..) => runtime::throw_dom_exception("DataCloneError", "#<ReadableStream> could not be cloned."),`);
    this.context.line(`${name}::WebController(..) => runtime::throw_dom_exception("DataCloneError", "#<ReadableStreamDefaultController> could not be cloned."),`);
    this.context.line(`${name}::WebReader(..) => runtime::throw_dom_exception("DataCloneError", "#<ReadableStreamDefaultReader> could not be cloned."),`);
    this.context.line(`${name}::FetchReader(..) => runtime::throw_dom_exception("DataCloneError", "#<ReadableStreamDefaultReader> could not be cloned."),`);
    this.context.line(`${name}::HttpResponse(..) => runtime::throw_dom_exception("DataCloneError", "#<ServerResponse> could not be cloned."),`);
    this.context.line(`${name}::HttpAgent(..) => runtime::throw_dom_exception("DataCloneError", "#<Agent> could not be cloned."),`);
    this.context.line(`${name}::ArrayIterator(..) => runtime::throw_dom_exception("DataCloneError", "#<Array Iterator> could not be cloned."),`);
    if (usesEmbeddedModules) this.context.line(`${name}::Island(..) => runtime::throw_dom_exception("DataCloneError", "embedded JavaScript value could not be cloned."),`);
    this.context.line(`${name}::Array(value) => {`);
    this.context.pushIndent();
    this.context.line("let identity = value.identity();");
    this.context.line("if parents.contains(&identity) { runtime::throw_value(runtime::error_new(\"Error\", runtime::string(\"structuredClone of cyclic values (the checked-dynamic tree cannot represent cycles) is not supported yet\"))); }");
    this.context.line("parents.push(identity);");
    this.context.line(`let output: runtime::JsArray<${name}> = runtime::array_new(Vec::new());`);
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::array_len(value) { let field = runtime::array_get(value, index); runtime::array_push(&output, sc_dyn_clone_dates(&field, parents, dates)); index += 1.0; }");
    this.context.line("parents.pop();");
    this.context.line(`${name}::Array(output)`);
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`${name}::Object(value) => {`);
    this.context.pushIndent();
    this.context.line("if runtime::map_is_module_namespace(value) { runtime::throw_dom_exception(\"DataCloneError\", \"[object Module] could not be cloned.\"); }");
    this.context.line("let identity = value.identity();");
    this.context.line("if parents.contains(&identity) { runtime::throw_value(runtime::error_new(\"Error\", runtime::string(\"structuredClone of cyclic values (the checked-dynamic tree cannot represent cycles) is not supported yet\"))); }");
    this.context.line("parents.push(identity);");
    this.context.line(`let output: ${mapType} = runtime::map_new();`);
    this.context.line("let mut index = 0.0;");
    this.context.line("while index < runtime::map_iter_count(value) {");
    this.context.pushIndent();
    this.context.line("if runtime::map_iter_live(value, index) { let key = runtime::map_iter_key(value, index); let field = runtime::map_iter_value(value, index); runtime::map_set_by(&output, key, sc_dyn_clone_dates(&field, parents, dates), |left, right| left.as_ref() == right.as_ref()); }");
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

    emitRustDynamicEquality(this.context, boxedShapes);
  }

  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName = "", liveRef = false): string {
    return this.dynFrom.emit(type, value, loc, functionName, liveRef);
  }

  emitDynFromDefinitions(): void {
    this.dynFrom.emitDefinitions();
  }

  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc, path = '"$"'): string {
    switch (type.kind) {
      case "dyn": case "jsval": return value;
      case "date": return `sc_dyn_check_date_at(${value}, ${path})`;
      case "effect": return `sc_dyn_check_effect_at(${value}, ${path})`;
      case "f64": return `sc_dyn_check_number_at(${value}, ${path})`;
      case "bigint": return `sc_dyn_check_bigint_at(${value}, ${path})`;
      case "bool": return `sc_dyn_check_boolean_at(${value}, ${path})`;
      case "string": return `sc_dyn_check_string_at(${value}, ${path})`;
      case "bytes": {
        if (type.elem !== "u8") this.context.unsupported(`dynamic checked cast to bytes<${type.elem}>`, loc);
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::Bytes(bytes) | ${name}::Buffer(bytes) => runtime::live_dyn_ref_get(bytes.identity()).unwrap_or(bytes), value => sc_dyn_check_fail_at("bytes", &value, ${path}), } }`;
      }
      case "netSocket": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::NetSocket(socket) => socket, value => sc_dyn_check_fail_at("Socket", &value, ${path}), } }`;
      }
      case "netServer": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::NetServer(server) => server, value => sc_dyn_check_fail_at("Server", &value, ${path}), } }`;
      }
      case "httpReq": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::HttpRequest(request) => request, value => sc_dyn_check_fail_at("IncomingMessage", &value, ${path}), } }`;
      }
      case "httpRes": {
        const name = this.context.dynTypeName();
        return `{ let value = ${value}; match value { ${name}::HttpResponse(response) => response, value => sc_dyn_check_fail_at("ServerResponse", &value, ${path}), } }`;
      }
      case "func": return `${this.context.dynFunctionCheckName(this.context.closureShapeForType(type, loc))}(${value})`;
      case "object": {
        if (!RUNTIME_ERROR_CLASSES.has(type.className)) {
          this.context.unsupported(`dynamic checked cast to object '${type.className}'`, loc);
        }
        return `sc_dyn_error_unbox(${value})`;
      }
      case "union": {
        const union = this.context.union(type.unionId, loc);
        if (sharedDiscriminatedUnion(this.context, union)) return discriminatedUnionCheck(this.context, union, value, path);
        const dyn = this.context.dynTypeName();
        const arrayTag = union.arms.findIndex((arm) =>
          arm.kind === "array"
        );
        const optionalArrayExit = arrayTag >= 0 &&
          union.arms.every((arm, tag) => tag === arrayTag || this.context.isUnit(arm));
        if (optionalArrayExit) {
          const name = this.context.unionName(union.id);
          const units = union.arms.flatMap((arm, tag) => {
            const source = arm.kind === "undefinedT" ? "Undefined" : arm.kind === "nullT" ? "Null" : null;
            return source === null ? [] : [`${dyn}::${source} => ${name}::${this.context.unionVariant(tag)}`];
          });
          const arm = union.arms[arrayTag];
          if (arm === undefined) this.context.unsupported("missing optional array arm", loc);
          const checked = this.emitDynCheckValue(arm, `${dyn}::Array(sc_array)`, loc, path);
          const array = `${dyn}::Array(sc_array) => ${name}::${this.context.unionVariant(arrayTag)}(${checked})`;
          return `{ let value = ${value}; match value { ${units.join(", ")}, ${array}, value => sc_dyn_check_fail_at("array or undefined", &value, ${path}), } }`;
        }
        const errorTag = union.arms.findIndex((arm) =>
          arm.kind === "object" && arm.className === "%Error"
        );
        const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
        const optionalError = errorTag >= 0 && undefinedTag >= 0 &&
          union.arms.every((_arm, tag) => tag === errorTag || tag === undefinedTag);
        if (optionalError) {
          const unionName = this.context.unionName(union.id);
          return `{ let value = ${value}; match value { ${dyn}::Undefined => ${unionName}::${this.context.unionVariant(undefinedTag)}, value => ${unionName}::${this.context.unionVariant(errorTag)}(sc_dyn_error_unbox(value)), } }`;
        }
        const records = union.arms.flatMap((arm, tag) => arm.kind === "record" ? [{ arm, tag }] : []);
        const shared = records[0];
        if (records.length === 1 && shared && isSharedRecord(this.context.records.get(shared.arm.shapeId)) &&
            union.arms.every((arm, tag) => tag === shared.tag || this.context.isUnit(arm))) {
          const name = this.context.unionName(union.id);
          const units = union.arms.flatMap((arm, tag) => {
            const source = arm.kind === "undefinedT" ? "Undefined" : arm.kind === "nullT" ? "Null" : null;
            return source === null ? [] : [`${dyn}::${source} => ${name}::${this.context.unionVariant(tag)}`];
          });
          const record = `${name}::${this.context.unionVariant(shared.tag)}(${this.emitDynCheckValue(shared.arm, "value", loc, path)})`;
          return `{ let value = ${value}; match value { ${units.join(", ")}, value => ${record}, } }`;
        }
        if (!this.context.isRustJsonCompatible(type)) {
          const native = emitNativeUnionCheck(this.context, union, value,
            (arm, input, loc) => this.emitDynCheckValue(arm, input, loc, path), loc, path);
          if (native !== null) return native;
          this.context.unsupported("dynamic checked cast to union", loc);
        }
        const name = this.context.unionName(union.id);
        const rustType = this.context.rustType(type, loc);
        const units = union.arms.flatMap((arm, tag) => {
          if (arm.kind !== "undefinedT" && arm.kind !== "nullT") return [];
          const source = arm.kind === "undefinedT" ? "Undefined" : "Null";
          return [`${dyn}::${source} => ${name}::${this.context.unionVariant(tag)}`];
        });
        const decode = `let node = sc_dyn_to_json(&value, ${path}).unwrap_or_else(|message| runtime::throw_type_error(message)); <${rustType} as runtime::JsonDecode>::decode_json(&node, ${path}).unwrap_or_else(|message| runtime::throw_type_error(message))`;
        return units.length === 0
          ? `{ let value = ${value}; ${decode} }`
          : `{ let value = ${value}; match value { ${units.join(", ")}, value => { ${decode} }, } }`;
      }
      case "array": {
        const name = this.context.dynTypeName();
        if (nativeArrayViewSupported(type)) return emitNativeArrayCheck(type, value, name,
          (element, item) => this.emitDynFromValue(element, item, loc), (element, item, itemPath) => this.emitDynCheckValue(element, item, loc, itemPath), path);
        if (type.elem.kind === "dyn" || type.elem.kind === "jsval") {
          return `match ${value} { ${name}::Array(array) => array, value => sc_dyn_check_fail_at("array", &value, ${path}) }`;
        }
        if (!this.context.isRustJsonCompatible(type)) this.context.unsupported("dynamic checked cast to array", loc);
        const rustType = this.context.rustType(type, loc);
        return `{ let value = ${value}; match value { ${name}::Array(array) => runtime::array_mapped_source(&array).or_else(|| runtime::live_dyn_ref_get(array.identity())).unwrap_or_else(|| { let node = sc_dyn_to_json(&${name}::Array(array), ${path}).unwrap_or_else(|message| runtime::throw_type_error(message)); <${rustType} as runtime::JsonDecode>::decode_json(&node, ${path}).unwrap_or_else(|message| runtime::throw_type_error(message)) }), value => sc_dyn_check_fail_at("array", &value, ${path}), } }`;
      }
      case "record": {
        if (type.kind === "record") {
          const shape = this.context.records.get(type.shapeId);
          if (isSharedRecord(shape)) {
            const input = this.context.hasEmbeddedModules() && this.context.isRustJsonCompatible(type)
              ? `sc_dyn_typed_island_input(${value})` : value;
            return `${recordCheckName(type.shapeId)}_at(${input}, ${path})`;
          }
          const indexValue = nativeIndexedRecordValue(type, id => this.context.records.get(id), id => this.context.union(id, loc));
          if (indexValue !== undefined && indexValue.kind !== "dyn") return emitNativeMapCheck(indexValue, value, this.context.dynTypeName(),
            (element, item) => this.emitDynFromValue(element, item, loc), (element, item, itemPath) => this.emitDynCheckValue(element, item, loc, itemPath), path);
          if (shape?.indexValue?.kind === "dyn" && shape.fields.length === 0) {
            const name = this.context.dynTypeName();
            return `{ let value = ${value}; match value { ${name}::Object(object) => object, value => sc_dyn_check_fail_at("object", &value, ${path}), } }`;
          }
        }
        if (!this.context.isRustJsonCompatible(type)) {
          this.context.unsupported(`dynamic checked cast to '${type.kind}'`, loc);
        }
        const rustType = this.context.rustType(type, loc);
        const live = `${this.context.dynTypeName()}::Object(mirror)`;
        return `{ let value = ${value}; let live: Option<${rustType}> = match &value { ${live} => runtime::live_dyn_ref_get(mirror.identity()), _ => None }; live.unwrap_or_else(|| { let node = sc_dyn_to_json(&value, ${path}).unwrap_or_else(|message| runtime::throw_type_error(message)); <${rustType} as runtime::JsonDecode>::decode_json(&node, ${path}).unwrap_or_else(|message| runtime::throw_type_error(message)) }) }`;
      }
      default:
        this.context.unsupported(`dynamic checked cast to '${type.kind}'`, loc);
    }
  }

}
