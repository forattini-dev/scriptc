import type { IrRecordShape, IrType } from "../../ir/nodes.js";
import { typeEquals } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** Can every value reached by a dynamic record key surface as `type`? */
export function recordKeyResultOk(
  L: Lowerer,
  shape: IrRecordShape,
  type: IrType,
): boolean {
  const surfaces = (candidate: IrType): boolean =>
    typeEquals(candidate, type) ||
    (type.kind === "union" && L.armTag(type.unionId, candidate) >= 0) ||
    (type.kind === "dyn" && L.dynConvertible(candidate));
  if (!shape.fields.every((field) => surfaces(field.type))) return false;
  if (shape.indexValue) {
    if (type.kind === "dyn") return shape.indexValue.kind === "dyn";
    if (!surfaces(shape.indexValue)) return false;
  }
  return true;
}
