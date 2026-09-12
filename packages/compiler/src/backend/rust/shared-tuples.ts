import type { IrFunction, IrRecordShape } from "../../ir/ir.js";
import { nativeTupleElement } from "../../ir/native-tuple.js";
import { mangleField, mangleFunction, mangleRecordStruct } from "../mangle.js";
import type { RustDefinitionContext } from "./definitions.js";
import { isSharedRecord, recordCheckName, recordNewName, sharedRecordName } from "./shared-records.js";

/** A tuple view has typed positional accessors over the original array. */
export function emitSharedTupleDefinition(context: RustDefinitionContext, shape: IrRecordShape): void {
  const element = nativeTupleElement(shape);
  if (!element) context.unsupported(`shared tuple '${shape.id}'`);
  const name = sharedRecordName(shape.id);
  const dyn = context.dynTypeName();
  const struct = mangleRecordStruct(shape.id);
  context.line(`#[derive(Clone)] struct ${name} { object: runtime::JsArray<${dyn}> }`);
  context.line(`impl PartialEq for ${name} { fn eq(&self, other: &Self) -> bool { runtime::array_ptr_eq(&self.object, &other.object) } }`);
  context.line(`impl ${name} {`);
  context.line("fn identity(&self) -> usize { runtime::array_identity(&self.object) }");
  context.line("fn ptr_eq(&self, other: &Self) -> bool { runtime::array_ptr_eq(&self.object, &other.object) }");
  for (const field of shape.fields) {
    const index = `${Number(field.name)}.0`;
    const read = `if ${index} < runtime::array_len(&self.object) { runtime::array_get(&self.object, ${index}) } else { ${dyn}::Undefined }`;
    context.line(`fn get_${mangleField(field.name)}(&self) -> ${context.rustType(field.type)} { ${context.emitDynCheckValue(field.type, read)} }`);
    context.line(`fn set_${mangleField(field.name)}(&self, value: ${context.rustType(field.type)}) { runtime::array_set(&self.object, ${index}, ${context.emitDynFromValue(field.type, "value")}); }`);
  }
  context.line("}");
  context.line(`impl runtime::Trace for ${name} { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { tracer.edge(&self.object); } }`);
  context.line(`impl runtime::HeapValue for ${name} { fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { tracer.edge(&self.object); } }`);
  context.line(`impl runtime::ArrayElement for ${name} { fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { tracer.edge(&self.object); } }`);
  context.line(`impl runtime::JsonValue for ${name} { fn write_json(&self, writer: &mut runtime::JsonWriter) { runtime::JsonValue::write_json(&self.object, writer); } }`);
  context.line(`impl runtime::JsonDecode for ${name} { fn decode_json(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {`);
  context.line(`let fields = runtime::json_expect_array(node, path)?; if fields.len() < ${shape.fields.length} { return Err(format!("expected at least ${shape.fields.length} tuple elements at {path}")); }`);
  context.line(`for (index, value) in fields.iter().enumerate() { let _ = <${context.rustType(element)} as runtime::JsonDecode>::decode_json(value, &runtime::json_index_path(path, index))?; }`);
  context.line("Ok(Self { object: runtime::JsonDecode::decode_json(node, path)? }) } }");
  context.line(`fn ${recordCheckName(shape.id)}(value: ${dyn}) -> ${name} { ${recordCheckName(shape.id)}_at(value, "$") }`);
  context.line(`fn ${recordCheckName(shape.id)}_at(value: ${dyn}, path: &str) -> ${name} {`);
  context.line(`let object = match value { ${dyn}::Array(array) => array, value => sc_dyn_check_fail_at("array", &value, path) };`);
  context.line(`if runtime::array_len(&object) < ${shape.fields.length}.0 { sc_dyn_check_fail_at("tuple arity", &${dyn}::Array(object), path); }`);
  context.line(`let mut index = 0.0; while index < runtime::array_len(&object) { let value = runtime::array_get(&object, index); let _ = ${context.emitDynCheckValue(element, "value", undefined, "&runtime::json_index_path(path, index as usize)")}; index += 1.0; }`);
  context.line(`${name} { object } }`);
  context.line(`fn ${recordNewName(shape.id)}(value: ${struct}) -> ${name} {`);
  const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
  const values = fields.map(field => context.emitDynFromValue(field.type, `value.${mangleField(field.name)}${context.isEdgeValue(field.type) ? '.expect("scriptc: cleared tuple construction field")' : ''}`));
  context.line(`${name} { object: runtime::array_new(vec![${values.join(", ")}]) } }`);
}

/** Intrinsics must see the current length and values of a shared tuple. */
export function emitSharedTupleOperation(context: RustDefinitionContext, fn: IrFunction): boolean {
  const operation = /^%tuple\.(length|read|join|spread)\.\d+$/.exec(fn.name)?.[1];
  const source = fn.params[0]?.type;
  const shape = source?.kind === "record" ? context.records.get(source.shapeId) : undefined;
  const element = nativeTupleElement(shape);
  if (!operation || !source || !element || !isSharedRecord(shape) || fn.captures !== undefined || fn.async || fn.generator) return false;
  const args = fn.params.map((param, index) => `sc_arg${index}: ${context.rustType(param.type)}`);
  const array = context.emitDynCheckValue({ kind: "array", elem: element }, `${context.dynTypeName()}::Array(sc_arg0.object)`);
  const value = operation === "length" ? "runtime::array_len(&sc_arg0.object)"
    : operation === "join" ? `runtime::array_join(&(${array}), &sc_arg1)`
    : operation === "read" ? `runtime::array_get(&(${array}), sc_arg1)`
    : `{ let array = ${array}; runtime::array_slice(&array, 0.0, runtime::array_len(&array)) }`;
  context.line(`fn ${mangleFunction(fn.name)}(${args.join(", ")}) -> ${context.rustType(fn.returnType)} { ${value} }`);
  return true;
}
