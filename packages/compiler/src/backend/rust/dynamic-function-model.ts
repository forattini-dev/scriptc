import type { IrRecordShape, IrType, IrUnionDef } from "../../ir/nodes.js";
import type { IrFuncType } from "./model.js";

/** Register function values nested inside a value crossing into checked dyn.
 * The dynFrom emitter recursively boxes records/arrays/unions, so discovery
 * must make the same walk before Rust closure enums are emitted. */
export function registerDynamicFunctionShapes(
  type: IrType,
  records: ReadonlyMap<string, IrRecordShape>,
  unions: ReadonlyMap<string, IrUnionDef>,
  register: (type: IrFuncType) => void,
  active = new Set<string>(),
): void {
  if (type.kind === "func") {
    register(type);
    return;
  }
  if (type.kind === "array" || type.kind === "promise") {
    registerDynamicFunctionShapes(type.kind === "array" ? type.elem : type.inner, records, unions, register, active);
    return;
  }
  if (type.kind === "record") {
    const key = `record:${type.shapeId}`;
    if (active.has(key)) return;
    const shape = records.get(type.shapeId);
    if (shape === undefined) return;
    active.add(key);
    for (const field of shape.fields) registerDynamicFunctionShapes(field.type, records, unions, register, active);
    if (shape.indexValue !== undefined) registerDynamicFunctionShapes(shape.indexValue, records, unions, register, active);
    active.delete(key);
    return;
  }
  if (type.kind !== "union") return;
  const key = `union:${type.unionId}`;
  if (active.has(key)) return;
  const union = unions.get(type.unionId);
  if (union === undefined) return;
  active.add(key);
  for (const arm of union.arms) registerDynamicFunctionShapes(arm, records, unions, register, active);
  active.delete(key);
}
