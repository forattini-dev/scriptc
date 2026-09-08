import type { IrModule, IrRecordShape, IrType, IrUnionDef } from "../../ir/nodes.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { RustDefinitionContext } from "./definitions.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";
import { nativeRecordShapeSupported } from "../../ir/native-record.js";

const sharedStorage = Symbol("Rust shared record storage");
type SharedShape = IrRecordShape & { [sharedStorage]?: true };

export function isSharedRecord(shape: IrRecordShape | undefined): boolean {
  return (shape as SharedShape | undefined)?.[sharedStorage] === true;
}

export function sharedRecordName(id: string): string { return `ScShared_${mangleRecordStruct(id)}`; }
export function recordNewName(id: string): string { return `sc_new_${mangleRecordStruct(id)}`; }
export function recordCheckName(id: string): string { return `sc_check_${mangleRecordStruct(id)}`; }

/** Storage planning is local to one Rust emission. Clone metadata rather
 * than changing the shared IR or the explicit C/LLVM backends. Static-only
 * shapes retain their typed structs; boundary shapes share one dynamic map. */
export function planSharedRecords(mod: IrModule, records: Map<string, IrRecordShape>, unions: ReadonlyMap<string, IrUnionDef>): boolean {
  let selected = false;
  const mark = (type: IrType): void => {
    if (type.kind === "union") { for (const arm of unions.get(type.unionId)?.arms ?? []) mark(arm); }
    if (type.kind === "promise") mark(type.inner);
    if (type.kind === "func") { type.params.forEach(mark); mark(type.ret); }
    if (type.kind !== "record") return;
    const shape = records.get(type.shapeId);
    if (!shape || (shape.fields.length === 0 && shape.indexValue !== undefined) || !nativeRecordShapeSupported(shape, unions)) return;
    records.set(shape.id, { ...shape, [sharedStorage]: true } as SharedShape);
    selected = true;
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== "object") return;
    const node = value as { kind?: string; value?: { type: IrType }; type?: IrType };
    if ((node.kind === "dynFrom" || node.kind === "jsMarshal") && node.value) mark(node.value.type);
    if ((node.kind === "dynCheck" || node.kind === "jsExit") && node.type) mark(node.type);
    Object.values(value).forEach(visit);
  };
  visit(mod);
  return selected;
}

export function emitSharedRecordDefinition(context: RustDefinitionContext, shape: IrRecordShape): void {
  const struct = mangleRecordStruct(shape.id);
  if (!isSharedRecord(shape)) {
    context.line(`fn ${recordNewName(shape.id)}(value: ${struct}) -> runtime::Gc<${struct}> { runtime::Gc::new(value) }`);
    return;
  }
  const name = sharedRecordName(shape.id);
  const dyn = context.dynTypeName();
  context.line(`#[derive(Clone)] struct ${name} { object: runtime::JsMap<runtime::JsString, ${dyn}> }`);
  context.line(`impl PartialEq for ${name} { fn eq(&self, other: &Self) -> bool { self.object.ptr_eq(&other.object) } }`);
  context.line(`impl ${name} {`);
  context.line("fn identity(&self) -> usize { self.object.identity() }");
  context.line("fn ptr_eq(&self, other: &Self) -> bool { self.object.ptr_eq(&other.object) }");
  for (const field of shape.fields) {
    const key = `runtime::string("${context.rustString(field.name)}")`;
    const get = `runtime::map_get_by(&self.object, &${key}, |a, b| a == b).unwrap_or(${dyn}::Undefined)`;
    context.line(`fn get_${mangleField(field.name)}(&self) -> ${context.rustType(field.type)} { ${context.emitDynCheckValue(field.type, get)} }`);
    context.line(`fn set_${mangleField(field.name)}(&self, value: ${context.rustType(field.type)}) { runtime::map_set_by(&self.object, ${key}, ${context.emitDynFromValue(field.type, "value")}, |a, b| a == b); }`);
  }
  context.line("}");
  context.line(`impl runtime::Trace for ${name} { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { tracer.edge(&self.object); } }`);
  context.line(`impl runtime::HeapValue for ${name} { fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { tracer.edge(&self.object); } }`);
  context.line(`impl runtime::ArrayElement for ${name} { fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { tracer.edge(&self.object); } }`);
  context.line(`impl runtime::JsonValue for ${name} { fn write_json(&self, writer: &mut runtime::JsonWriter) { runtime::JsonValue::write_json(&self.object, writer); } }`);
  context.line(`impl runtime::JsonDecode for ${name} { fn decode_json(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {`);
  context.line("let fields = runtime::json_expect_object(node, path)?;");
  for (const field of shape.fields) {
    const key = `"${context.rustString(field.name)}"`;
    const type = context.rustType(field.type);
    const optional = field.type.kind === "undefinedT" || (field.type.kind === "union" &&
      context.union(field.type.unionId).arms.some(arm => arm.kind === "undefinedT"));
    const decode = `<${type} as runtime::JsonDecode>::decode_json(value, &runtime::json_property_path(path, ${key}))?`;
    context.line(optional
      ? `if let Some(value) = runtime::json_object_field(fields, ${key}) { let _ = ${decode}; }`
      : `{ let value = runtime::json_required_field(fields, ${key}, path)?; let _ = ${decode}; }`);
  }
  context.line("Ok(Self { object: runtime::JsonDecode::decode_json(node, path)? }) }");
  context.line("}");
  context.line(`fn ${recordCheckName(shape.id)}(value: ${dyn}) -> ${name} {`);
  context.line(`let object = match value { ${dyn}::Object(object) => object, value => sc_dyn_check_fail("object", &value) };`);
  context.line(`let record = ${name} { object };`);
  for (const field of shape.fields) context.line(`let _ = record.get_${mangleField(field.name)}();`);
  context.line("record }");
  context.line(`fn ${recordNewName(shape.id)}(value: ${struct}) -> ${name} {`);
  context.line(`let object: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new();`);
  const fields = new Map(shape.fields.map(field => [field.name, field]));
  for (const key of shape.declaredOrder ?? shape.fields.map(field => field.name)) {
    const field = fields.get(key);
    if (field === undefined) context.unsupported(`unknown shared record field '${shape.id}.${key}'`);
    const value = context.isEdgeValue(field.type)
      ? `value.${mangleField(key)}.expect("scriptc: cleared record construction field")`
      : `value.${mangleField(key)}`;
    context.line(`runtime::map_set_by(&object, runtime::string("${context.rustString(key)}"), ${context.emitDynFromValue(field.type, value)}, |a, b| a == b);`);
  }
  if (shape.indexValue) {
    context.line(`if let Some(overflow) = value.${RUST_RECORD_OVERFLOW} { let mut index = 0.0; while index < runtime::map_iter_count(&overflow) { if runtime::map_iter_live(&overflow, index) { runtime::map_set_by(&object, runtime::map_iter_key(&overflow, index), runtime::map_iter_value(&overflow, index), |a, b| a == b); } index += 1.0; } }`);
  }
  context.line(`${name} { object } }`);
}
