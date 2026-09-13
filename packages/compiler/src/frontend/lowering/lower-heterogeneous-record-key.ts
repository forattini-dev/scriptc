import type * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type IrRecordShape } from "../../ir/ir.js";
import { nativeRecordCheckSupported } from "../../ir/native-record.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** A heterogeneous service lookup keeps the live shared map, including
 * properties retained by width coercion. Explicit dynFrom makes closure
 * discovery, storage planning and backend admission see the same boundary.
 * The dynamic lookup evaluates receiver/key once, before selecting a field.
 * Records without a shared representation retain the ordinary refusal. */
export function lowerHeterogeneousRecordKeyRead(
  L: Lowerer, expr: ts.ElementAccessExpression, object: IrExpr, key: IrExpr, shape: IrRecordShape,
): IrExpr | null {
  if (object.type.kind !== "record" || object.type.shapeId !== shape.id || shape.tuple || shape.indexValue !== undefined ||
    shape.fields.length === 0 || shape.fields.some(field => field.name.startsWith("%")) ||
    !nativeRecordCheckSupported(object.type, id => L.shapes.get(id), id => L.unions.get(id)) ||
    !L.dynConvertible(object.type)) return null;
  const loc = locOf(expr);
  return { kind: "dynKeyGet", value: { kind: "dynFrom", value: object, type: DYN, loc }, key, type: DYN, loc };
}
