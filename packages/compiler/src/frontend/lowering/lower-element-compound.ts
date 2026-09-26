import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { CompoundOp } from "./surfaces.js";
import { arrayValueRead, arrayValueStore } from "./array-values.js";
import { lowerOptionalNumber } from "./lower-exprs.js";
import { varRef } from "../../ir/build.js";
import { F64, IrExpr, IrStmt, STRING, UNDEFINED_T } from "../../ir/ir.js";
import { locOf } from "../program.js";

/** `a[i] op= rhs` over native arrays and byte views. A compound assignment
 * evaluates the receiver and index, reads the old element, evaluates rhs,
 * then writes. Capture each stage so a call in the index or rhs cannot
 * change the target or the value used by the operator. The expression yields
 * the computed value before a typed array or Buffer coerces it for storage.
 * Ported from upstream #396; the fork's frontend has no
 * fenceNodeModuleMutation equivalent, so that node-module edge is left to the
 * ordinary element-write path. */
export function lowerElementCompound(lowerer: Lowerer, expr: ts.BinaryExpression, op: CompoundOp): IrExpr {
  const target = expr.left as ts.ElementAccessExpression;
  const loc = locOf(expr);
  const receiverType = lowerer.mapTypeOf(lowerer.typeOf(target.expression));
  if (receiverType?.kind !== "array" && receiverType?.kind !== "bytes") {
    lowerer.unsupported("SC1090", target, "compound assignment to non-array elements");
  }
  let receiver = lowerer.lowerExpr(target.expression);
  if (receiver.type.kind === "union" && lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0) {
    const present = lowerer.stripUndefinedArm(receiver.type);
    const helper = present.kind === receiverType.kind
      ? lowerer.narrowedArmHelper(receiver.type.unionId, present, locOf(target.expression))
      : null;
    if (helper) receiver = { kind: "call", callee: helper, args: [receiver], type: present, loc: locOf(target.expression) };
  }
  if (receiver.type.kind !== receiverType.kind) {
    lowerer.unsupported("SC1090", target.expression, "compound assignment through a non-native array or byte view");
  }
  const index = lowerer.lowerExpr(target.argumentExpression);
  if (index.type.kind !== "f64") lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
  const receiverLocal = lowerer.declareHiddenLocal("%compoundArray", receiver.type);
  const indexLocal = lowerer.declareHiddenLocal("%compoundIndex", F64);
  const receiverRef = (): IrExpr => varRef(receiverLocal.id, receiver.type, loc);
  const indexRef = (): IrExpr => varRef(indexLocal.id, F64, loc);
  const oldValue: IrExpr = receiver.type.kind === "array"
    ? arrayValueRead(lowerer, receiverRef(), indexRef(), receiver.type.elem, locOf(target))
    : { kind: "bytesIntrinsic", method: "get", receiver: receiverRef(), args: [indexRef()], type: F64, loc: locOf(target) };
  const oldLocal = lowerer.declareHiddenLocal("%compoundOld", oldValue.type);
  const oldRef = (): IrExpr => varRef(oldLocal.id, oldValue.type, loc);
  const rhs = lowerer.lowerExpr(expr.right);
  const numericRhs = lowerOptionalNumber(lowerer, rhs, loc);
  const elementType = receiver.type.kind === "array" ? receiver.type.elem : F64;
  const valueType = elementType.kind === "union" && lowerer.armTag(elementType.unionId, UNDEFINED_T) >= 0
    ? lowerer.stripUndefinedArm(elementType)
    : elementType;
  let computed: IrExpr;
  if (op === "+" && valueType.kind === "string") {
    computed = {
      kind: "strConcat",
      left: lowerer.ensureString(oldRef(), target),
      right: lowerer.ensureString(rhs, expr.right),
      type: STRING,
      loc,
    };
  } else if (valueType.kind === "f64" && numericRhs.type.kind === "f64") {
    computed = { kind: "bin", op, left: lowerOptionalNumber(lowerer, oldRef(), loc), right: numericRhs, type: F64, loc };
  } else {
    lowerer.unsupported("SC1043", expr);
  }
  const resultLocal = lowerer.declareHiddenLocal("%compoundResult", computed.type);
  const resultRef = (): IrExpr => varRef(resultLocal.id, computed.type, loc);
  const write: IrStmt = receiver.type.kind === "array"
    ? arrayValueStore(lowerer, receiverRef(), indexRef(), resultRef(), receiver.type.elem, loc)
    : { kind: "bytesSet", arr: receiverRef(), index: indexRef(), value: resultRef(), loc };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: indexLocal.id, init: index, loc },
      { kind: "varDecl", localId: oldLocal.id, init: oldValue, loc },
      { kind: "varDecl", localId: resultLocal.id, init: computed, loc },
      write,
    ],
    result: resultRef(),
    type: computed.type,
    loc,
  };
}
