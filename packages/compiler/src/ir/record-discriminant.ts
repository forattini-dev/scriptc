import type { IrRecordShape, IrUnionDef } from "./ir.js";

/** Every record arm must own a distinct nonempty string-literal domain. */
export function validRecordDiscriminant(union: IrUnionDef, getRecord: (id: string) => IrRecordShape | undefined): boolean {
  const discriminator = union.discriminant;
  if (!discriminator || typeof discriminator.field !== "string" || !Array.isArray(discriminator.cases)) return false;
  const records = union.arms.filter(arm => arm.kind === "record");
  if (records.length < 2 || records.length !== discriminator.cases.length ||
    !union.arms.every(arm => ["record", "undefinedT", "nullT"].includes(arm.kind))) return false;
  const shapes = new Set(records.map(arm => arm.shapeId));
  const seen = new Set<string>();
  for (const entry of discriminator.cases) {
    if (!entry || !shapes.delete(entry.shapeId) || !Array.isArray(entry.values) || entry.values.length === 0) return false;
    const shape = getRecord(entry.shapeId);
    if (!shape || shape.tuple || shape.fields.find(field => field.name === discriminator.field)?.type.kind !== "string") return false;
    for (const value of entry.values) {
      if (typeof value !== "string" || seen.has(value)) return false;
      seen.add(value);
    }
  }
  return shapes.size === 0;
}
