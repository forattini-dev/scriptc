import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, typeEquals, typeKey, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import { probeLower } from "./lower-probe.js";

/** A generic constraint can admit an optional property omitted by some of
 * the concrete record variants. Read the active variant without reshaping it. */
export function lowerOptionalRecordField(L: Lowerer, expr: ts.PropertyAccessExpression, lowered?: IrExpr): IrExpr | null {
  const checkerType = L.typeOf(expr);
  const resultT = L.mapTypeOf(checkerType) ??
    (L.typeParamBindings !== null && checkerType.flags & ts.TypeFlags.Any ? DYN : null);
  const loc = locOf(expr);
  const absent = resultT?.kind === "dyn" ? dynUndefinedExpr(loc) : resultT ? L.wrappedUndefined(resultT, loc) : null;
  if (!resultT || !absent) return null;
  const probed = lowered ?? probeLower(L, expr.expression);
  if (!probed || (probed.type.kind !== "record" && probed.type.kind !== "union")) return null;
  const sourceT = probed.type;
  const arms = sourceT.kind === "record" ? [sourceT] : L.unions.get(sourceT.unionId)?.arms;
  if (!arms?.length) return null;
  const variants = [];
  for (const arm of arms) {
    if (arm.kind !== "record") return null;
    const shape = L.shapes.get(arm.shapeId);
    if (!shape || shape.tuple || shape.indexValue || shape.fields.some(field =>
      field.name === `%get:${expr.name.text}` || field.name === `%set:${expr.name.text}`)) return null;
    const field = shape.fields.find(field => field.name === expr.name.text);
    // Admit only value-preserving tag conversions, never a structural copy.
    const surfaces = (type: IrType): boolean => typeEquals(type, resultT) ||
      (type.kind === "union" && (L.unions.get(type.unionId)?.arms.every(surfaces) ?? false)) ||
      (resultT.kind === "union" && L.armTag(resultT.unionId, type) >= 0) ||
      (resultT.kind === "dyn" && ["f64", "string", "bool", "undefinedT", "nullT"].includes(type.kind));
    if (field && !surfaces(field.type)) return null;
    variants.push({ arm, field });
  }
  if (variants.every(variant => variant.field !== undefined)) return null;
  const receiver = lowered ?? L.lowerExpr(expr.expression);
  if (sourceT.kind === "record") {
    return { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: receiver, loc }], result: absent, type: resultT, loc };
  }
  const key = `record.optional:${sourceT.unionId}:${expr.name.text}:${typeKey(resultT)}`;
  let helper = L.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%record.optional.${L.arrHofHelpers.size}`;
    const ref: IrExpr = { kind: "varRef", localId: "r.0", type: sourceT, loc };
    const body: IrStmt[] = variants.map(({ arm, field }, tag) => {
      const value = field ? L.coerceToExpected({ kind: "recordGet", shapeId: arm.shapeId, field: field.name,
        obj: { kind: "unionNarrow", unionId: sourceT.unionId, tag, value: ref, type: arm, loc }, type: field.type, loc }, resultT) : absent;
      const returned: IrStmt = { kind: "return", value, loc };
      return tag === variants.length - 1 ? returned : { kind: "if",
        cond: { kind: "unionIsTag", unionId: sourceT.unionId, tag, value: ref, negated: false, type: BOOL, loc },
        then: [returned], else_: null, loc };
    });
    L.arrHofHelpers.set(key, helper);
    L.liftedFns.push({ name: helper, params: [{ localId: "r.0", name: "r", type: sourceT }],
      locals: [{ id: "r.0", name: "r", type: sourceT, mutable: false }], returnType: resultT, body, loc });
  }
  return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
}
