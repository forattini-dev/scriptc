import type { IrRecordShape, IrType, IrUnionDef } from "./ir.js";

export function validDnsLookupPromiseResult(type: IrType, records: ReadonlyMap<string, IrRecordShape>, unions: ReadonlyMap<string, IrUnionDef>): boolean {
  if (type.kind !== "promise" || type.inner.kind !== "record") return false;
  const shape = records.get(type.inner.shapeId);
  if (shape?.fields.length !== 2 || shape.tuple || shape.indexValue !== undefined) return false;
  const address = shape.fields.find(field => field.name === "address")?.type;
  const family = shape.fields.find(field => field.name === "family")?.type;
  const union = address?.kind === "union" ? unions.get(address.unionId) : undefined;
  return family?.kind === "f64" && union?.arms.length === 2 &&
    union.arms.some(arm => arm.kind === "string") && union.arms.some(arm => arm.kind === "nullT");
}
