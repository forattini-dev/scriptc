import type { IrRecordShape, IrType, IrUnionDef } from "./nodes.js";

/** Native reference storage currently supports scalar declared fields and
 * unknown-valued extras. Other composites need their own shared layout. */
export function nativeRecordShapeSupported(shape: IrRecordShape, unions: Pick<ReadonlyMap<string, IrUnionDef>, "get">): boolean {
  const scalar = (type: IrType): boolean => type.kind === "union"
    ? unions.get(type.unionId)?.arms.every(scalar) ?? false
    : ["f64", "bool", "string", "nullT", "undefinedT"].includes(type.kind);
  return !shape.tuple && (shape.indexValue === undefined || shape.indexValue.kind === "dyn") &&
    shape.fields.every(field => !field.name.startsWith("%") && scalar(field.type));
}
