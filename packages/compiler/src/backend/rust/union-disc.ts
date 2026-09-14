import type { IrExpr } from "../../ir/ir.js";
import { RUNTIME_ERROR_CLASSES } from "../../ir/ir.js";
import { mangleField } from "../mangle.js";
import type { RustExpressionContext } from "./expressions.js";
import { isSharedRecord } from "./shared-records.js";

type UnionDiscContext = Pick<RustExpressionContext,
  "classDef" | "classFieldName" | "isEdgeValue" | "isUnit" | "needsClone" |
  "nextName" | "records" | "union" | "unionName" | "unionVariant" | "unsupported"
>;

/** Shared-field read `r.f` over a union: a match on the runtime tag reading
 * the same-typed field from each record or class arm. Unit arms are the ones
 * the checker narrowed away (`x !== undefined`, an optional chain's guard). */
export function emitRustUnionDisc(
  expr: Extract<IrExpr, { kind: "unionDisc" }>,
  context: UnionDiscContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const union = context.union(expr.unionId, expr.loc);
  const value = context.nextName("sc_rt");
  const arms = union.arms.map((arm, tag) => {
    const variant = `${context.unionName(union.id)}::${context.unionVariant(tag)}`;
    if (context.isUnit(arm)) return `${variant} => unreachable!("scriptc: nullish arm of a narrowed union read")`;
    if (arm.kind === "object") {
      if (RUNTIME_ERROR_CLASSES.has(arm.className)) context.unsupported(`union discriminant on builtin error '${arm.className}'`, expr.loc);
      const cls = context.classDef(arm.className, expr.loc);
      const field = cls.fields.find((candidate) => candidate.name === expr.field);
      if (field === undefined) context.unsupported(`unknown class field '${arm.className}.${expr.field}'`, expr.loc);
      const access = `object.${context.classFieldName(arm.className, field.name, expr.loc)}`;
      const result = context.isEdgeValue(field.type)
        ? `${access}.as_ref().expect("scriptc: cleared live class field").clone()`
        : context.needsClone(field.type) ? `${access}.clone()` : access;
      return `${variant}(payload) => payload.with(|object| ${result})`;
    }
    if (arm.kind !== "record") context.unsupported(`union discriminant arm '${arm.kind}'`, expr.loc);
    const shape = context.records.get(arm.shapeId);
    const field = shape?.fields.find((candidate) => candidate.name === expr.field);
    if (shape === undefined || field === undefined) {
      context.unsupported(`unknown union discriminant field '${arm.shapeId}.${expr.field}'`, expr.loc);
    }
    if (isSharedRecord(shape)) return `${variant}(payload) => payload.get_${mangleField(field.name)}()`;
    const access = `record.${mangleField(field.name)}`;
    const result = context.isEdgeValue(field.type)
      ? `${access}.as_ref().expect("scriptc: cleared live union field").clone()`
      : context.needsClone(field.type) ? `${access}.clone()` : access;
    return `${variant}(payload) => payload.with(|record| ${result})`;
  }).join(", ");
  return `{ let ${value} = ${emitExpr(expr.value)}; match &${value} { ${arms} } }`;
}
