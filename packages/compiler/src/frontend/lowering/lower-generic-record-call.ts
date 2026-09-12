import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, UNDEFINED_T, typeEquals, typeKey, shapeHasAccessorSlots, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { probeLower } from "./lower-probe.js";
import { omittedArgFor } from "./lower-calls.js";

/** A narrowed generic constraint can hide several concrete callback ABIs.
 * Read the original closure before evaluating arguments, then dispatch its
 * tag. Neither stage projects or copies the receiver's record layout. */
export function lowerGenericRecordUnionCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (!L.typeParamBindings || call.arguments.some(ts.isSpreadElement)) return null;
  const checkerType = L.typeOf(access);
  const declared = L.mapTypeOf(checkerType);
  // Generic identity calls can leave a checker-any property despite an
  // exact concrete receiver. Its callback ABI still comes from storage.
  if (declared?.kind !== "func" && !(checkerType.flags & ts.TypeFlags.Any)) return null;
  const probed = probeLower(L, access.expression);
  if (probed?.type.kind !== "union") return null;
  const source = probed.type;
  const arms = L.unions.get(source.unionId)?.arms;
  if (!arms?.length) return null;
  const variants = [];
  for (const arm of arms) {
    if (arm.kind !== "record") return null;
    const shape = L.shapes.get(arm.shapeId);
    if (!shape || shape.tuple || shape.indexValue || shapeHasAccessorSlots(shape)) return null;
    const field = shape.fields.find(field => field.name === access.name.text);
    if (field && field.type.kind !== "func") return null;
    variants.push({ arm, field });
  }
  const funcs = variants.flatMap(({ field }) => field?.type.kind === "func" ? [field.type] : []);
  const first = funcs[0];
  if (!first || call.arguments.length > first.params.length) return null;
  // Arguments must have one exact ABI across variants. Returning to the
  // constraint may box scalars or retag unions, but never copy composites.
  const resultT = declared?.kind === "func" ? declared.ret : DYN;
  const surfaces = (type: IrType): boolean => typeEquals(type, resultT) ||
    (type.kind === "union" && (L.unions.get(type.unionId)?.arms.every(surfaces) ?? false)) ||
    (resultT.kind === "union" && L.armTag(resultT.unionId, type) >= 0) ||
    (resultT.kind === "dyn" && ["f64", "string", "bool", "undefinedT", "nullT"].includes(type.kind));
  if (!funcs.every(fn => fn.params.length === first.params.length &&
    fn.params.every((param, index) => typeEquals(param, first.params[index]!)) && surfaces(fn.ret))) return null;
  const loc = locOf(call);
  const missingArgs: IrExpr[] = [];
  for (let i = call.arguments.length; i < first.params.length; i++) {
    const absent = omittedArgFor(L, first.params[i]!, loc);
    if (!absent) return null;
    missingArgs.push(absent);
  }
  const callbackArms: IrType[] = [...new Map(funcs.map(fn => [typeKey(fn), fn])).values()];
  if (variants.some(({ field }) => !field)) callbackArms.push(UNDEFINED_T);
  callbackArms.sort((a, b) => typeKey(a) < typeKey(b) ? -1 : 1);
  const callbackT: IrType = callbackArms.length === 1 ? callbackArms[0]! :
    { kind: "union", unionId: L.unions.intern(callbackArms) };
  const key = `record.callback:${source.unionId}:${access.name.text}:${typeKey(resultT)}:${access.getText()}`;
  let reader = L.arrHofHelpers.get(key);
  let invoker = L.arrHofHelpers.get(`${key}:invoke`);
  if (!reader || !invoker) {
    reader = `%record.callback.${L.arrHofHelpers.size}`;
    invoker = `${reader}.invoke`;
    const ref: IrExpr = { kind: "varRef", localId: "r.0", type: source, loc };
    const readBody: IrStmt[] = variants.map(({ arm, field }, tag) => {
      const value: IrExpr = field ? { kind: "recordGet", shapeId: arm.shapeId, field: field.name,
        obj: { kind: "unionNarrow", unionId: source.unionId, tag, value: ref, type: arm, loc }, type: field.type, loc } :
        { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
      const returned: IrStmt = { kind: "return", value: L.coerceToExpected(value, callbackT), loc };
      return tag === variants.length - 1 ? returned : { kind: "if",
        cond: { kind: "unionIsTag", unionId: source.unionId, tag, value: ref, negated: false, type: BOOL, loc },
        then: [returned], else_: null, loc };
    });
    L.liftedFns.push({ name: reader, params: [{ localId: "r.0", name: "r", type: source }],
      locals: [{ id: "r.0", name: "r", type: source, mutable: false }], returnType: callbackT, body: readBody, loc });
    const callback: IrExpr = { kind: "varRef", localId: "f.0", type: callbackT, loc };
    const params = [{ localId: "f.0", name: "f", type: callbackT },
      ...first.params.map((type, i) => ({ localId: `a.${i}`, name: `a${i}`, type }))];
    const args: IrExpr[] = params.slice(1).map(param => ({ kind: "varRef", localId: param.localId, type: param.type, loc }));
    const body: IrStmt[] = callbackArms.map((arm, tag) => {
      let action: IrStmt;
      if (arm.kind === "func") {
        const callee: IrExpr = callbackT.kind === "union" ?
          { kind: "unionNarrow", unionId: callbackT.unionId, tag, value: callback, type: arm, loc } : callback;
        const result: IrExpr = { kind: "callValue", callee, args, type: arm.ret, loc };
        action = { kind: "return", value: L.coerceToExpected(result, resultT), loc };
      } else {
        action = { kind: "throw", value: { kind: "libCall", fn: "error.new", args: [
          { kind: "strLit", value: `${access.getText()} is not a function`, type: STRING, loc },
        ], type: { kind: "object", className: "%TypeError" }, loc }, loc };
      }
      return tag === callbackArms.length - 1 || callbackT.kind !== "union" ? action : { kind: "if",
        cond: { kind: "unionIsTag", unionId: callbackT.unionId, tag, value: callback, negated: false, type: BOOL, loc },
        then: [action], else_: null, loc };
    });
    L.liftedFns.push({ name: invoker, params,
      locals: params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
      returnType: resultT, body, loc });
    L.arrHofHelpers.set(key, reader);
    L.arrHofHelpers.set(`${key}:invoke`, invoker);
  }
  const read: IrExpr = { kind: "call", callee: reader, args: [L.lowerExpr(access.expression)], type: callbackT, loc };
  const args = call.arguments.map((arg, i) => L.lowerExprExpecting(arg, first.params[i]));
  return { kind: "call", callee: invoker, args: [read, ...args, ...missingArgs], type: resultT, loc };
}
