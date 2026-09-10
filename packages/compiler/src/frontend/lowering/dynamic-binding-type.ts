import type { IrType } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** Keep checked-dynamic storage when a binding's checker type contains
 * opaque members. Object.entries(object), for example, infers an array of
 * [string, unknown] tuples. Extracting that container into a static copy
 * would lose aliases; routing it through the engine would also copy it.
 * This only selects local storage: typed exits still validate their values.
 * Explicit native container annotations retain their existing checks. */
export function dynamicBindingType(L: Lowerer, type: IrType, inferred: boolean): boolean {
  if (type.kind === "jsval" || (type.kind === "array" && type.elem.kind === "jsval")) return true;
  if (!inferred) return false;
  const seen = new Set<string>();
  const containsOpaque = (t: IrType): boolean => {
    if (t.kind === "dyn" || t.kind === "jsval") return true;
    if (t.kind === "array") return containsOpaque(t.elem);
    if (t.kind !== "record" || seen.has(t.shapeId)) return false;
    seen.add(t.shapeId);
    const shape = L.shapes.get(t.shapeId);
    return shape?.tuple === true && shape.fields.some((field) => containsOpaque(field.type));
  };
  return containsOpaque(type);
}
