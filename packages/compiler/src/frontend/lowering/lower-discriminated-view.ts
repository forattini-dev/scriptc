import { DYN, type IrExpr, type IrType, typeEquals } from "../../ir/ir.js";
import { nativeRecordCheckSupported } from "../../ir/native-record.js";
import type { Lowerer } from "./lowerer.js";

/** Ambiguous callable variants need a checked discriminated view. A unique
 * structural arm can use the ordinary width adapter, which Rust shares. */
export function discriminatedViewSupported(L: Lowerer, source: IrType, target: IrType): boolean {
  if (target.kind !== "union") return false;
  const union = L.unions.get(target.unionId);
  if (!union?.discriminant ||
    L.jsonSafe(target) || typeEquals(source, target) || L.armTag(target.unionId, source) >= 0) return false;
  const supported = (type: IrType) => nativeRecordCheckSupported(type, id => L.shapes.get(id), id => L.unions.get(id));
  if (!supported(source) || !supported(target) || !L.dynConvertible(source)) return false;
  // Prefer a concrete structural conversion when exactly one arm fits.
  // Ambiguous or dynamic sources keep discriminator-based validation.
  return source.kind !== "record" || union.arms.filter(arm => arm.kind === "record" &&
    L.recordWidthPlan(source.shapeId, arm.shapeId) !== null).length !== 1;
}

export function lowerDiscriminatedView(L: Lowerer, value: IrExpr, target: IrType): IrExpr | null {
  if (!discriminatedViewSupported(L, value.type, target)) return null;
  return { kind: "dynCheck", value: { kind: "dynFrom", value, type: DYN, loc: value.loc }, type: target, loc: value.loc };
}
