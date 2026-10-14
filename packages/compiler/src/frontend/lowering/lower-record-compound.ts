import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { F64, STRING, UNDEFINED_T, shapeHasAccessorSlots, typeEquals, type IrExpr, type IrType } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import type { CompoundOp } from "./surfaces.js";
import { lowerOptionalNumber, lowerRecordPropertyKey } from "./lower-exprs.js";

/** Capture receiver, key and old value before rhs, then reuse the record's
 * read/write rules. Literal-typed key calls still evaluate exactly once. */
export function lowerRecordElementCompound(L: Lowerer, expr: ts.BinaryExpression, op: CompoundOp, type: IrType): IrExpr | null {
  if (type.kind !== "record") return null;
  const shape = L.shapes.get(type.shapeId);
  if (!shape || shape.tuple || shapeHasAccessorSlots(shape)) return null;
  const slot = shape.indexValue ?? shape.fields[0]?.type;
  if (!slot || !shape.fields.every(field => typeEquals(field.type, slot))) return null;
  const scalar = slot.kind === "union" && L.armTag(slot.unionId, UNDEFINED_T) >= 0 ? L.stripUndefinedArm(slot) : slot;
  if (scalar.kind !== "f64" && scalar.kind !== "string") return null;
  const target = expr.left as ts.ElementAccessExpression;
  const loc = locOf(expr);
  const receiver = L.lowerExpr(target.expression);
  if (!typeEquals(receiver.type, type)) L.unsupported("SC1090", target, "record compound assignment through an unrepresented receiver");
  const key = lowerRecordPropertyKey(L, L.lowerExpr(target.argumentExpression), target.argumentExpression);
  if (key.type.kind !== "string") L.unsupported("SC1090", target.argumentExpression, "record compound assignment with a non-string property key");
  const receiverLocal = L.declareHiddenLocal("%compoundRecord", type);
  const keyLocal = L.declareHiddenLocal("%compoundKey", STRING);
  const receiverRef = varRef(receiverLocal.id, type, loc);
  const keyRef = varRef(keyLocal.id, STRING, loc);
  const bound = <T>(lower: () => T): T => L.withExpressionOverride(target.expression, receiverRef, () =>
    L.withExpressionOverride(target.argumentExpression, keyRef, lower));
  const oldValue = bound(() => L.lowerRecordKeyRead(target, type.shapeId, shape, shape.indexValue !== undefined));
  const oldLocal = L.declareHiddenLocal("%compoundOld", oldValue.type);
  const oldRef = varRef(oldLocal.id, oldValue.type, loc);
  const rhs = L.lowerExpr(expr.right);
  let computed: IrExpr;
  if (op === "+" && scalar.kind === "string") {
    computed = { kind: "strConcat", left: L.ensureString(oldRef, target), right: L.ensureString(rhs, expr.right), type: STRING, loc };
  } else {
    const left = lowerOptionalNumber(L, oldRef, loc), right = lowerOptionalNumber(L, rhs, loc);
    if (scalar.kind !== "f64" || left.type.kind !== "f64" || right.type.kind !== "f64") L.unsupported("SC1043", expr);
    computed = { kind: "bin", op, left, right, type: F64, loc };
  }
  const resultLocal = L.declareHiddenLocal("%compoundResult", computed.type);
  const resultRef = varRef(resultLocal.id, computed.type, loc);
  const write = bound(() => L.withExpressionOverride(expr.right, resultRef, () => L.lowerElementWrite(expr)));
  return {
    kind: "seqExpr", stmts: [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: keyLocal.id, init: key, loc },
      { kind: "varDecl", localId: oldLocal.id, init: oldValue, loc },
      { kind: "varDecl", localId: resultLocal.id, init: computed, loc }, write,
    ], result: resultRef, type: computed.type, loc,
  };
}
