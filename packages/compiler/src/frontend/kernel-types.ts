/* Kernel-aware TYPE shapes beyond the opaque handle: a DECORATED schema — effect's schema value intersected with
 * program statics (`Schema.String.pipe(Schema.brand("ID"), statics((s) => ({ create: () => s.make(…) })))`, the
 * `Object.assign(schema, methods)` idiom) — is a record of the plain part's fields plus a hidden schema slot; every
 * schema site unwraps the slot, every static reads the field. */
import * as ts from "./ts7/adapter.js";
import { EFFECT_T, type IrRecordShape, type IrType } from "../ir/nodes.js";
import { mapType, type TypeMapperCtx } from "./types.js";

export const SCHEMA_SLOT = "%schema";

/** The record for `Schema & { … }` parts: null unless one-or-more parts are schema handles and every other part is a
 * plain record (no index signature, no tuple) with distinct field names. */
export function decoratedSchemaRecord(parts: readonly ts.Type[], ctx: TypeMapperCtx): IrType | null {
  const mapped = parts.map((part) => mapType(part, ctx));
  const schemas = mapped.filter((m) => m?.kind === "effect").length;
  if (schemas === 0 || schemas === parts.length) return null;
  const fields: { name: string; type: IrType }[] = [{ name: SCHEMA_SLOT, type: EFFECT_T }];
  const order: string[] = [];
  for (const m of mapped) {
    if (m?.kind === "effect") continue;
    if (m?.kind !== "record") return null;
    const shape = ctx.shapes.get(m.shapeId);
    if (shape === undefined || shape.indexValue !== undefined || shape.tuple === true) return null;
    for (const field of shape.fields) {
      if (fields.some((f) => f.name === field.name)) return null;
      fields.push(field);
    }
    order.push(...(shape.declaredOrder ?? shape.fields.map((f) => f.name)));
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "record", shapeId: ctx.shapes.intern(fields, false, undefined, order) };
}

/** True for a record type carrying the schema slot. */
export function isDecoratedSchema(shapes: { get(id: string): IrRecordShape | undefined }, type: IrType): boolean {
  return type.kind === "record" && (shapes.get(type.shapeId)?.fields.some((f) => f.name === SCHEMA_SLOT) ?? false);
}
