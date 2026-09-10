import * as ts from "./ts7/adapter.js";
import type { IrType, IrUnionDef } from "../ir/nodes.js";
import type { TypeMapperCtx } from "./types.js";

/** Retain a common string-literal field whose domains are disjoint by shape.
 * Layouts still erase literals; source spelling order never chooses an arm. */
export function recordUnionDiscriminant(
  type: ts.Type, arms: IrType[], ctx: TypeMapperCtx, map: (part: ts.Type) => IrType | null,
): IrUnionDef["discriminant"] {
  const records = arms.filter(arm => arm.kind === "record");
  if (records.length < 2 || !arms.every(arm => ["record", "nullT", "undefinedT"].includes(arm.kind))) return undefined;
  const parts = ts.constituentTypes(type).flatMap(part => {
    const mapped = map(part);
    return mapped?.kind === "record" ? [{ type: part, shapeId: mapped.shapeId }] : [];
  });
  const first = parts[0];
  if (!first) return undefined;
  const literals = (value: ts.Type): string[] | undefined => {
    if (value.isStringLiteralType()) return [value.value];
    if (!value.isUnionType()) return undefined;
    const nested = ts.constituentTypes(value).map(literals);
    return nested.every((part): part is string[] => part !== undefined) ? nested.flat() : undefined;
  };
  for (const field of ctx.checker.getPropertiesOfType(first.type).map(prop => prop.name).sort()) {
    const byShape = new Map<string, Set<string>>();
    let valid = true;
    for (const part of parts) {
      const prop = ctx.checker.getPropertyOfType(part.type, field);
      const values = prop ? literals(ctx.checker.getTypeOfSymbol(prop)) : undefined;
      if (!values?.length) { valid = false; break; }
      const set = byShape.get(part.shapeId) ?? new Set<string>();
      values.forEach(value => set.add(value));
      byShape.set(part.shapeId, set);
    }
    if (!valid || byShape.size !== records.length) continue;
    const seen = new Set<string>();
    const cases: { shapeId: string; values: string[] }[] = [];
    for (const arm of records) {
      const values = [...(byShape.get(arm.shapeId) ?? [])].sort();
      if (values.length === 0 || values.some(value => seen.has(value))) { valid = false; break; }
      values.forEach(value => seen.add(value));
      cases.push({ shapeId: arm.shapeId, values });
    }
    if (valid) return { field, cases };
  }
  return undefined;
}
