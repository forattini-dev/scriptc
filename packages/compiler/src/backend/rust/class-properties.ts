import type { IrType } from "../../ir/ir.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/ir.js";
import { nativeArrayViewSupported } from "../../ir/native-record.js";
import { rustClassFieldName } from "./metadata.js";
import type { RustDynamicContext } from "./dynamic-context.js";
import type { RustClassMeta } from "./model.js";
import { isSharedRecord } from "./shared-records.js";
import { rustJsString } from "./string-literals.js";

/** Read the original class storage, outside its Gc borrow, before boxing the
 * result. The identity capsule stays a reference, never a snapshot of fields. */
export function emitRustClassPropertyReads(context: RustDynamicContext, box: (type: IrType, value: string) => string): void {
  if (!context.usesDyn()) return;
  const roots = new Map<string, RustClassMeta>();
  const seen = new Set<string>();
  const errors = context.errorClassRoots();
  const visitType = (type: IrType): void => {
    const key = typeKey(type);
    if (seen.has(key)) return;
    seen.add(key);
    switch (type.kind) {
      case "object": {
        if (RUNTIME_ERROR_CLASSES.has(type.className)) return;
        const root = context.classMetaOf(type.className).root;
        if (root.def.runtime === true || errors.includes(root) || roots.has(root.def.name)) return;
        roots.set(root.def.name, root);
        const visitClass = (meta: RustClassMeta): void => {
          for (const field of meta.def.fields) if (!field.name.startsWith("%")) visitType(field.type);
          for (const child of meta.children) visitClass(child);
        };
        visitClass(root);
        return;
      }
      case "array": case "set": visitType(type.elem); return;
      case "promise": visitType(type.inner); return;
      case "map": visitType(type.key); visitType(type.value); return;
      case "func": for (const param of type.params) visitType(param); visitType(type.ret); return;
      case "record": {
        const record = context.records.get(type.shapeId);
        for (const field of record?.fields ?? []) visitType(field.type);
        if (record?.indexValue !== undefined) visitType(record.indexValue);
        return;
      }
      case "union": for (const arm of context.union(type.unionId).arms) visitType(arm); return;
    }
  };
  const scan = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) scan(child); return; }
    const value = node as { kind?: string; value?: { type: IrType } };
    if (value.kind === "dynFrom" && value.value !== undefined) visitType(value.value.type);
    for (const child of Object.values(node)) scan(child);
  };
  scan(context.module());
  const readable = (type: IrType): boolean => {
    switch (type.kind) {
      case "dyn": case "f64": case "string": case "bool": case "undefinedT": case "nullT":
      case "void": case "bigint": case "symbol": case "regex": case "date": case "effect":
      case "url": case "searchParams": case "bytes": case "object": return true;
      case "func": return context.dynBoxedFunctionShapes.has(typeKey(type));
      case "record": {
        const record = context.records.get(type.shapeId);
        return record !== undefined && isSharedRecord(record);
      }
      case "array": return nativeArrayViewSupported(type, id => context.records.get(id), id => context.union(id));
      case "map": return type.key.kind === "dyn" && type.value.kind === "dyn";
      case "set": return type.elem.kind === "dyn";
      case "union": return context.union(type.unionId).arms.every(readable);
      default: return false;
    }
  };
  const dyn = context.dynTypeName();
  context.line(`fn sc_dyn_class_key_get(object: &runtime::JsMap<runtime::JsString, ${dyn}>, key: &runtime::JsString) -> Option<${dyn}> {`);
  context.pushIndent();
  for (const root of roots.values()) {
    context.line(`if let Some(instance) = runtime::live_dyn_ref_get::<${context.rustType({kind: "object", className: root.def.name})}>(object.identity()) {`);
    context.pushIndent();
    if (root.hierarchy) { context.line("match instance.with(|data| data.sc_class_pre) {"); context.pushIndent(); }
    const emitClass = (meta: RustClassMeta): void => {
      if (root.hierarchy) { context.line(`${meta.pre} => {`); context.pushIndent(); }
      for (const field of meta.def.fields.filter(field => !field.name.startsWith("%"))) {
        context.line(`if key == &${rustJsString(field.name, value => context.rustString(value))} {`);
        context.pushIndent();
        if (readable(field.type)) {
          const stored = `data.${rustClassFieldName(meta, field.name)}`;
          const value = context.isEdgeValue(field.type) ? `${stored}.as_ref().expect("scriptc: cleared class field").clone()` : context.needsClone(field.type) ? `${stored}.clone()` : stored;
          context.line(`let value = instance.with(|data| ${value});`);
          context.line(`return Some(${box(field.type, "value")});`);
        } else {
          context.line('runtime::throw_type_error("scriptc: erased class data field representation is not ported".into());');
        }
        context.popIndent(); context.line("}");
      }
      if (root.hierarchy) { context.popIndent(); context.line("},"); }
      for (const child of meta.children) emitClass(child);
    };
    emitClass(root);
    if (root.hierarchy) { context.line('_ => unreachable!("scriptc: invalid class identity"),'); context.popIndent(); context.line("}"); }
    context.line("return None;");
    context.popIndent(); context.line("}");
  }
  context.line("None");
  context.popIndent(); context.line("}");
}
