import { UNDEFINED_T, isUnitType, typeEquals, canMarshalTypedFuncIntoIsland, canAdaptDynFuncTo, type IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { promiseViewCoercible } from "./lower-promise-view.js";

export function coercibleValue(L: Lowerer, src: IrType, dst: IrType): boolean {
  if (typeEquals(src, dst)) return true;
  if (promiseViewCoercible(L, src, dst)) return true;
  // The island boundary joins the mechanical set: values that MARSHAL
  // in (units, the checked-dynamic deep copy, JSON-safe data, liftable
  // composites, marshalable closures — coerceToExpected's jsval-IN
  // block) and island handles whose exits VALIDATE (boundaryExitSafe) —
  // the `defaultFallback(cfg) { return { login, id, scopes } }` shape,
  // whose slot returns a package ('any') type.
  if (dst.kind === "jsval") {
    return (
      src.kind !== "jsval" &&
      (isUnitType(src) ||
        src.kind === "dyn" ||
        L.boundarySafe(src) ||
        L.jsvalLiftable(src) ||
        (src.kind === "func" &&
          canMarshalTypedFuncIntoIsland(src, (id) => L.shapes.get(id), (id) => L.unions.get(id))))
    );
  }
  if (src.kind === "jsval") return L.boundaryExitSafe(dst);
  if (dst.kind === "dyn") return src.kind !== "dyn" && L.dynConvertible(src);
  if (src.kind === "dyn") {
    // The checked-dynamic function boundary's OUT direction joins the
    // mechanical set: a dyn result landing in an adaptable func slot
    // takes dynCheck's per-target shim (coerceToExpected's funcOk rule
    // — the production/development function-choice ternary shape).
    return (
      L.jsonSafe(dst) ||
      (dst.kind === "func" && canAdaptDynFuncTo(dst, (id) => L.shapes.get(id), (id) => L.unions.get(id)))
    );
  }
  // Function parameters are contravariant at the adapter boundary. A
  // slot record may therefore enter the wrapped callback through the
  // same exact copy/optional-completion plan as any ordinary record
  // assignment (`P` into `P & { key?: string }` completes key with the
  // undefined arm). recordWidthPlan is a pure probe here; the adapter's
  // coerceToExpected call interns the helper only after every piece has
  // been admitted.
  if (src.kind === "record" && dst.kind === "record") {
    return L.recordWidthPlan(src.shapeId, dst.shapeId) !== null;
  }
  if (dst.kind === "union") {
    if (src.kind === "union") return L.unionRetagMappable(src.unionId, dst.unionId);
    if (src.kind === "void") return L.armTag(dst.unionId, UNDEFINED_T) >= 0;
    return !isUnitType(src) && L.armTag(dst.unionId, src) >= 0;
  }
  if (src.kind === "union") {
    return !isUnitType(dst) && dst.kind !== "void" && L.armTag(src.unionId, dst) >= 0;
  }
  return false;
}
