import * as ts from "../ts7/adapter.js";
import { DYN, VOID, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { probeLower } from "./lower-probe.js";
import { lowerThrowingDynamicValue } from "./lower-open-record.js";

/** A checked-dynamic write in value position keeps the same boxed RHS for
 * both the property and the expression result. Capture the reference before
 * the RHS; defer key conversion until afterwards, as PutValue requires. */
export function lowerComputedAssignment(L: Lowerer, target: ts.ElementAccessExpression, right: ts.Expression): IrExpr | null {
  if (target.questionDotToken || L.isIslandExpr(target.expression)) return null;
  let receiver = target.expression;
  while (ts.isParenthesizedExpression(receiver) || ts.isAssertionExpression(receiver) || ts.isNonNullExpression(receiver) || ts.isSatisfiesExpression(receiver)) receiver = receiver.expression;
  const object = probeLower(L, receiver);
  if (!object || (object.type.kind !== "dyn" && !(L.nativeDenseArrays && object.type.kind === "array" && object.type.elem.kind === "dyn"))) return null;
  const loc = locOf(target);
  const recv = L.declareHiddenLocal("%computedSetRecv", object.type);
  const rawKey = lowerThrowingDynamicValue(L, target.argumentExpression, L.lowerExpr(target.argumentExpression));
  if (rawKey.type.kind !== "dyn") L.unsupported("SC1090", target.argumentExpression, `computed assignment with '${L.fmt(rawKey.type)}' keys`);
  const key = L.declareHiddenLocal("%computedSetKey", rawKey.type);
  let valueNode = right;
  while (ts.isParenthesizedExpression(valueNode)) valueNode = valueNode.expression;
  const value = ts.isObjectLiteralExpression(valueNode)
    ? L.lowerExprExpecting(right, DYN)
    : lowerThrowingDynamicValue(L, right, L.lowerExpr(right));
  if (value.type.kind !== "dyn") L.unsupported("SC1101", right, `assigning '${L.fmt(value.type)}' values into a checked-dynamic member`);
  const stored = L.declareHiddenLocal("%computedSetValue", value.type);
  const valueRef: IrExpr = { kind: "varRef", localId: stored.id, type: value.type, loc };
  const keyRef: IrExpr = { kind: "varRef", localId: key.id, type: rawKey.type, loc };
  const recvRef: IrExpr = { kind: "varRef", localId: recv.id, type: object.type, loc };
  const dynRecv: IrExpr = object.type.kind === "dyn" ? recvRef : { kind: "dynFrom", value: recvRef, liveRef: true, type: DYN, loc };
  return {
    kind: "seqExpr", type: value.type, loc,
    stmts: [
      { kind: "varDecl", localId: recv.id, init: object, loc },
      { kind: "varDecl", localId: key.id, init: rawKey, loc },
      { kind: "varDecl", localId: stored.id, init: value, loc },
      { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.keySetComputed", args: [dynRecv, keyRef, valueRef], type: VOID, loc }, loc },
    ],
    result: valueRef,
  };
}
