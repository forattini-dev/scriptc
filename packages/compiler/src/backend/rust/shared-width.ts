import type { IrFunction, IrRecordShape, IrType, IrUnionDef } from "../../ir/nodes.js";
import { nativeRecordCheckSupported, nativeArrayViewSupported } from "../../ir/native-record.js";

/** Compiler-generated structural projections become reference views in Rust.
 * C/LLVM continue to emit the helper's ordinary field-copy body. */
export function sharedWidthPair(fn: IrFunction, records: ReadonlyMap<string, IrRecordShape>, unions: ReadonlyMap<string, IrUnionDef>) {
  if ((!fn.name.startsWith("%rec.width.") && !fn.name.startsWith("%rec.capture.") && !fn.name.startsWith("%tup.arr.")) || fn.params.length !== 1 || fn.captures !== undefined || fn.async || fn.generator) return null;
  const source = fn.params[0]?.type;
  const target = fn.returnType;
  if (source?.kind !== "record") return null;
  if (fn.name.startsWith("%tup.arr.") && records.get(source.shapeId)?.tuple && nativeRecordCheckSupported(source, id => records.get(id), id => unions.get(id)) && nativeArrayViewSupported(target)) return { source, target };
  if (target.kind !== "record") return null;
  const supported = (type: IrType) => nativeRecordCheckSupported(type, id => records.get(id), id => unions.get(id));
  return supported(source) && supported(target) ? { source, target } : null;
}
