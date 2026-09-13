import { rustJsString } from "./string-literals.js";
import { emitSharedTupleDefinition } from "./shared-tuples.js";
import { sharedWidthPair } from "./shared-width.js";
import type { IrModule, IrRecordShape, IrType, IrUnionDef } from "../../ir/ir.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { RustDefinitionContext } from "./definitions.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";
import { nativeRecordShapeSupported } from "../../ir/native-record.js";
import { rustCallReceiver } from "./call-receiver.js";
import type { IrExpr } from "../../ir/ir.js";

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
 * shapes retain their typed structs; boundary shapes retain an Object or Proxy. */
export function planSharedRecords(mod: IrModule, records: Map<string, IrRecordShape>, unions: ReadonlyMap<string, IrUnionDef>, explicitThis = false): boolean {
  let selected = false;
  const visited = new Set<string>();
  const wrappersByRecord = new Map<string, Set<string>>();
  const mark = (type: IrType): void => {
    if (type.kind === "union" || type.kind === "record") {
      const key = type.kind === "union" ? `union:${type.unionId}` : `record:${type.shapeId}`;
      if (visited.has(key)) return;
      visited.add(key);
    }
    if (type.kind === "union") { for (const arm of unions.get(type.unionId)?.arms ?? []) mark(arm); }
    if (type.kind === "promise") mark(type.inner);
    if (type.kind === "func") { type.params.forEach(mark); mark(type.ret); }
    if (type.kind !== "record") return;
    const shape = records.get(type.shapeId);
    if (!shape || isSharedRecord(shape) || !nativeRecordShapeSupported(shape, unions, id => records.get(id))) return;
    if (shape.indexValue !== undefined) {
      mark(shape.indexValue);
      if (shape.fields.length === 0) return;
    }
    records.set(shape.id, { ...shape, [sharedStorage]: true } as SharedShape);
    selected = true;
    shape.fields.forEach(field => mark(field.type));
    for (const unionId of wrappersByRecord.get(shape.id) ?? []) mark({ kind: "union", unionId });
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== "object") return;
    const node = value as { kind?: string; fn?: string; args?: { type: IrType }[]; value?: { type: IrType }; type?: IrType };
    if (explicitThis && node.kind === "callValue") {
      const receiver = rustCallReceiver((value as Extract<IrExpr, { kind: "callValue" }>).callee);
      if (receiver) mark(receiver.type);
    }
    const iterable = node.kind === "libCall" && node.fn === "fetch.streamFrom" ? node.args?.[0]?.type : undefined;
    if (iterable?.kind === "array") mark(iterable.elem);
    if ((node.kind === "dynFrom" || node.kind === "jsMarshal") && node.value) mark(node.value.type);
    if ((node.kind === "dynCheck" || node.kind === "jsExit") && node.type) mark(node.type);
    // Record the dependency even before this source becomes shared. A later
    // boundary may discover its storage after this union wrapper was visited.
    if (node.kind === "unionWrap" && node.type?.kind === "union" && unions.get(node.type.unionId)?.discriminant &&
      node.value?.type.kind === "record") {
      const wrappers = wrappersByRecord.get(node.value.type.shapeId) ?? new Set<string>();
      wrappers.add(node.type.unionId);
      wrappersByRecord.set(node.value.type.shapeId, wrappers);
    }
    Object.values(value).forEach(visit);
  };
  for (const fn of mod.functions) { const pair = sharedWidthPair(fn, records, unions); if (pair) { mark(pair.source); mark(pair.target); } }
  visit(mod);
  // The complete dependency graph makes propagation independent of IR order.
  // All variants of a shared view must recheck its live discriminator.
  for (const [shapeId, wrappers] of wrappersByRecord) {
    if (isSharedRecord(records.get(shapeId))) for (const unionId of wrappers) mark({ kind: "union", unionId });
  }
  return selected;
}

/** Shared field accessors need both read adapters and write boxes even when
 * the program crosses only one direction at explicit IR boundaries. */
export function registerSharedRecordMethods(
  records: ReadonlyMap<string, IrRecordShape>,
  register: (type: Extract<IrType, { kind: "func" }>) => void,
): void {
  for (const record of records.values()) if (isSharedRecord(record)) {
    for (const field of record.fields) if (field.type.kind === "func") register(field.type);
  }
}

export function emitSharedRecordDefinition(context: RustDefinitionContext, shape: IrRecordShape): void {
  const struct = mangleRecordStruct(shape.id);
  if (!isSharedRecord(shape)) {
    context.line(`fn ${recordNewName(shape.id)}(value: ${struct}) -> runtime::Gc<${struct}> { runtime::Gc::new(value) }`);
    return;
  }
  if (shape.tuple) { emitSharedTupleDefinition(context, shape); return; }
  const name = sharedRecordName(shape.id);
  const dyn = context.dynTypeName();
  context.line(`#[derive(Clone)] struct ${name} { object: ${dyn} }`);
  context.line(`impl PartialEq for ${name} { fn eq(&self, other: &Self) -> bool { self.ptr_eq(other) } }`);
  context.line(`impl ${name} {`);
  context.line(`fn identity(&self) -> usize { match &self.object { ${dyn}::Object(object) => runtime::map_identity(object), ${dyn}::Proxy(proxy) => proxy.identity(), _ => unreachable!("scriptc: invalid shared record storage") } }`);
  context.line(`fn ptr_eq(&self, other: &Self) -> bool { match (&self.object, &other.object) { (${dyn}::Object(left), ${dyn}::Object(right)) => runtime::map_ptr_eq(left, right), (${dyn}::Proxy(left), ${dyn}::Proxy(right)) => left.ptr_eq(right), _ => false } }`);
  // Keep ordinary reads on the existing map path. A Proxy read invokes Get
  // once, with the retained proxy itself as receiver, and validates afterward.
  context.line(`fn get_key(&self, key: &runtime::JsString) -> Option<${dyn}> { match &self.object { ${dyn}::Object(object) => runtime::map_get_by(object, key, |a, b| a == b), ${dyn}::Proxy(..) => Some(sc_dyn_get(&self.object, key, &self.object)), _ => unreachable!("scriptc: invalid shared record storage") } }`);
  // Reflection and mutation need additional Proxy internal methods. Refuse
  // explicitly until those contracts exist instead of observing an empty map.
  context.line(`fn own_object(&self, operation: &str) -> &runtime::JsMap<runtime::JsString, ${dyn}> { match &self.object { ${dyn}::Object(object) => object, ${dyn}::Proxy(..) => sc_dyn_proxy_unsupported(operation), _ => unreachable!("scriptc: invalid shared record storage") } }`);
  context.line(`fn set_key(&self, key: runtime::JsString, value: ${dyn}) { runtime::map_set_by(self.own_object("Set"), key, value, |a, b| a == b); }`);
  context.line('fn own_keys(&self) -> runtime::JsArray<runtime::JsString> { runtime::map_string_keys_js_order(self.own_object("ownKeys")) }');
  context.line(`fn shallow_copy(&self) -> Self { let source = self.own_object("CopyDataProperties"); let object = runtime::map_new(); let mut index = 0.0; while index < runtime::map_iter_count(source) { if runtime::map_iter_live(source, index) { runtime::map_set_by(&object, runtime::map_iter_key(source, index), runtime::map_iter_value(source, index), |a, b| a == b); } index += 1.0; } Self { object: ${dyn}::Object(object) } }`);
  for (const field of shape.fields) {
    const key = `${rustJsString(field.name, text => context.rustString(text))}`;
    const get = `self.get_key(&${key}).unwrap_or(${dyn}::Undefined)`;
    // Build diagnostic paths only during boundary validation, not ordinary reads.
    context.line(`fn get_${mangleField(field.name)}(&self) -> ${context.rustType(field.type)} { ${context.emitDynCheckValue(field.type, get)} }`);
    context.line(`fn get_${mangleField(field.name)}_at(&self, path: &str) -> ${context.rustType(field.type)} { ${context.emitDynCheckValue(field.type, get, undefined, `&runtime::json_property_path(path, "${context.rustString(field.name)}")`)} }`);
    context.line(`fn set_${mangleField(field.name)}(&self, value: ${context.rustType(field.type)}) { self.set_key(${key}, ${context.emitDynFromValue(field.type, "value")}); }`);
  }
  context.line("}");
  context.line(`impl runtime::Trace for ${name} { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(&self.object, tracer); } }`);
  context.line(`impl runtime::HeapValue for ${name} { fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(&self.object, tracer); } fn promise_resolution_error(&self) -> Option<&'static str> { runtime::HeapValue::promise_resolution_error(&self.object) } }`);
  context.line(`impl runtime::ArrayElement for ${name} { fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(&self.object, tracer); } }`);
  context.line(`impl runtime::JsonValue for ${name} { fn write_json(&self, writer: &mut runtime::JsonWriter) { runtime::JsonValue::write_json(&self.object, writer); } }`);
  context.line(`impl runtime::JsonDecode for ${name} { fn decode_json(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {`);
  if (shape.fields.some(field => !context.isRustJsonCompatible(field.type))) {
    const expected = shape.fields.some(field => field.type.kind === "func") ? "callable" : "native";
    context.line(`let _ = node; Err(format!("expected ${expected} record at {path}, got JSON")) }`);
  } else {
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
    context.line(`Ok(Self { object: ${dyn}::Object(runtime::JsonDecode::decode_json(node, path)?) }) }`);
  }
  context.line("}");
  context.line(`fn ${recordCheckName(shape.id)}(value: ${dyn}) -> ${name} { ${recordCheckName(shape.id)}_at(value, "$") }`);
  context.line(`fn ${recordCheckName(shape.id)}_at(value: ${dyn}, path: &str) -> ${name} {`);
  // A typed Proxy cast is a lazy view: do not read fields, enumerate keys or
  // populate the handler's caches merely to validate the asserted shape.
  context.line(`let object = match value { object @ ${dyn}::Proxy(..) => return ${name} { object }, object @ ${dyn}::Object(..) => object, value => sc_dyn_check_fail_at("object", &value, path) };`);
  context.line(`let record = ${name} { object };`);
  for (const field of shape.fields) context.line(`let _ = record.get_${mangleField(field.name)}_at(path);`);
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
    context.line(`runtime::map_set_by(&object, ${rustJsString(key, text => context.rustString(text))}, ${context.emitDynFromValue(field.type, value)}, |a, b| a == b);`);
  }
  if (shape.indexValue) {
    context.line(`if let Some(overflow) = value.${RUST_RECORD_OVERFLOW} { let mut index = 0.0; while index < runtime::map_iter_count(&overflow) { if runtime::map_iter_live(&overflow, index) { runtime::map_set_by(&object, runtime::map_iter_key(&overflow, index), runtime::map_iter_value(&overflow, index), |a, b| a == b); } index += 1.0; } }`);
  }
  context.line(`${name} { object: ${dyn}::Object(object) } }`);
}

/** Pure dictionaries keep JsMap storage; declared records use their wrapper. */
export function recordPointerEquality(shape: IrRecordShape | undefined, left: string, right: string): string {
  return shape?.fields.length === 0 && shape.indexValue !== undefined
    ? `runtime::map_ptr_eq(${left}, ${right})` : `(${left}).ptr_eq(${right})`;
}
