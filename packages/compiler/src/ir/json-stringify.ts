import { isJsonSafeType, typeKey, type IrRecordShape, type IrType, type IrUnionDef } from "./nodes.js";

/** Encoding may write undefined array slots as null; decoding must still
 * reject null where a string | undefined value is required. */
export function isJsonStringifyType(
  type: IrType,
  record: (id: string) => IrRecordShape | undefined,
  union: (id: string) => IrUnionDef | undefined,
): boolean {
  const visiting = new Set<string>();
  function visit(value: IrType, nested: boolean): boolean {
    if (isJsonSafeType(value, record, union)) return true;
    if (value.kind === "undefinedT") return nested;
    const key = `${typeKey(value)}:${nested}`;
    if (visiting.has(key)) return true;
    visiting.add(key);
    let result = false;
    if (value.kind === "array") result = visit(value.elem, true);
    if (value.kind === "union") result = union(value.unionId)?.arms.every((arm) => visit(arm, nested)) ?? false;
    if (value.kind === "record") {
      const shape = record(value.shapeId);
      result = shape !== undefined && shape.fields.every((field) => visit(field.type, true)) &&
        (shape.indexValue === undefined || shape.indexValue.kind === "dyn" || visit(shape.indexValue, true));
    }
    visiting.delete(key);
    return result;
  }
  return visit(type, false);
}
