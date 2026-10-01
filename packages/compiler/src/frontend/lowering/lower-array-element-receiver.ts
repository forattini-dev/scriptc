import * as ts from "../ts7/adapter.js";
import { BOOL, STRING, UNDEFINED_T, isUnitType, typeEquals, type IrExpr } from "../../ir/ir.js";
import { numLit, strLit, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** An unchecked outer array slot stays optional until both bracket operands
 * have run. Reuse the ordinary typed read with stabilized expression overrides. */
export function lowerArrayElementReceiver(L: Lowerer, expr: ts.ElementAccessExpression): IrExpr | null {
  if (!L.nativeDenseArrays || L.chainRecvByNode.has(expr.expression)) return null;
  let origin = expr.expression;
  while (ts.isParenthesizedExpression(origin)) origin = origin.expression;
  if (!ts.isElementAccessExpression(origin) || L.mapTypeOf(L.typeOf(origin.expression))?.kind !== "array") return null;
  const expected = L.mapTypeOf(L.typeOf(expr.expression));
  if (!expected || !["array", "record", "bytes"].includes(expected.kind)) return null;

  const value = L.lowerExpr(expr.expression);
  const source = L.runtimeOptionalSourceValue(expr.expression, value);
  if (source?.type.kind !== "union") return null;
  const unionId = source.type.unionId;
  const present = L.stripUndefinedArm(source.type);
  const def = L.unions.get(unionId);
  const valueTag = L.armTag(unionId, present);
  const missingTag = L.armTag(unionId, UNDEFINED_T);
  if (!def || valueTag < 0 || missingTag < 0 ||
    !["array", "record", "bytes"].includes(present.kind) ||
    !def.arms.every(arm => typeEquals(arm, present) || isUnitType(arm))) return null;

  const key = L.lowerExpr(expr.argumentExpression);
  if (key.type.kind !== "f64" && key.type.kind !== "string") return null;
  const loc = locOf(expr);
  const receiver = L.declareHiddenLocal("%elementReceiver", source.type);
  const index = L.declareHiddenLocal("%elementKey", key.type);
  const receiverRef = (): IrExpr => varRef(receiver.id, source.type, loc);
  const indexRef = (): IrExpr => varRef(index.id, key.type, loc);
  const keyText: IrExpr = key.type.kind === "string" ? indexRef() : { kind: "toString", operand: indexRef(), type: STRING, loc };
  const message: IrExpr = {
    kind: "strConcat",
    left: { kind: "strConcat", left: strLit("Cannot read properties of undefined (reading '", loc), right: keyText, type: STRING, loc },
    right: strLit("')", loc),
    type: STRING,
    loc,
  };
  const checked: IrExpr = {
    kind: "ternary",
    cond: { kind: "unionIsTag", unionId, tag: missingTag, negated: false, value: receiverRef(), type: BOOL, loc },
    then: { kind: "libCall", fn: "error.nodeThrow", args: [numLit(1, loc), strLit("", loc), message], type: present, loc },
    else_: { kind: "unionNarrow", unionId, tag: valueTag, value: receiverRef(), type: present, loc },
    type: present,
    loc,
  };
  const previousKey = L.chainRecvByNode.get(expr.argumentExpression);
  L.chainRecvByNode.set(expr.expression, checked);
  L.chainRecvByNode.set(expr.argumentExpression, indexRef());
  let result: IrExpr;
  try {
    result = L.lowerElementAccess(expr);
  } finally {
    L.chainRecvByNode.delete(expr.expression);
    if (previousKey) L.chainRecvByNode.set(expr.argumentExpression, previousKey);
    else L.chainRecvByNode.delete(expr.argumentExpression);
  }
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiver.id, init: source, loc },
      { kind: "varDecl", localId: index.id, init: key, loc },
    ],
    result,
    type: result.type,
    loc,
  };
}
