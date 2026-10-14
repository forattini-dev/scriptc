import type { IrExpr, IrType, SrcLoc } from "../../ir/ir.js";
import { BOOL, F64, STRING, UNDEFINED_T, typeKey } from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import type * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";

export function lowerStringIndexAccess(lowerer: Lowerer, expr: ts.ElementAccessExpression): IrExpr {
  const resultType = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const receiver = lowerer.lowerExpr(expr.expression);
  const index = lowerer.lowerExpr(expr.argumentExpression);
  const loc = locOf(expr);
  if (index.type.kind === "f64" && resultType?.kind === "union" &&
    lowerer.armTag(resultType.unionId, UNDEFINED_T) >= 0 && lowerer.stripUndefinedArm(resultType).kind === "string") {
    return lowerOptionalStringIndex(lowerer, receiver, index, resultType, loc);
  }
  // Preserve the existing string-typed lane's documented charAt behavior
  // when the checker supplies no undefined arm. The optional lane above
  // retains absence under noUncheckedIndexedAccess.
  if (index.type.kind === "f64" && resultType?.kind === "string") {
    return { kind: "strIntrinsic", method: "charAt", receiver, args: [index], type: STRING, loc };
  }
  return lowerer.unsupported("SC1090", expr, "string indexing with a non-number index or unsupported result type");
}

/** Optional numeric string access reads one UTF-16 code unit only for an
 * in-range integer property key. charAt alone would truncate fractions and
 * return an empty string for missing properties. Function parameters keep
 * receiver/index evaluation single and ordered, including effectful calls. */
function lowerOptionalStringIndex(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  resultType: IrType & { kind: "union" },
  loc: SrcLoc,
): IrExpr {
  const key = `str.idxOr:${typeKey(resultType)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = `%str.idxOr.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, name);
    const text = varRef("s.0", STRING, loc);
    const position = varRef("i.0", F64, loc);
    const compare = (op: "<" | ">=" | "===", left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op, left, right, type: BOOL, loc });
    const inRange: IrExpr = { kind: "logical", op: "&&", left: compare(">=", position, numLit(0, loc)), right: compare("<", position,
      { kind: "strIntrinsic", method: "length", receiver: text, args: [], type: F64, loc }), type: BOOL, loc };
    const integer = compare("===", position, { kind: "libCall", fn: "math.floor", args: [position], type: F64, loc });
    const present: IrExpr = { kind: "strIntrinsic", method: "charAt", receiver: text, args: [position], type: STRING, loc };
    const missing: IrExpr = { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
    const wrap = (value: IrExpr): IrExpr => ({ kind: "unionWrap", unionId: resultType.unionId,
      tag: lowerer.armTag(resultType.unionId, value.type), value, type: resultType, loc });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "s.0", name: "s", type: STRING }, { localId: "i.0", name: "i", type: F64 }],
      returnType: resultType,
      locals: [{ id: "s.0", name: "s", type: STRING, mutable: false }, { id: "i.0", name: "i", type: F64, mutable: false }],
      body: [{ kind: "return", value: { kind: "ternary", cond: { kind: "logical", op: "&&", left: inRange, right: integer, type: BOOL, loc },
        then: wrap(present), else_: wrap(missing), type: resultType, loc }, loc }],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [receiver, index], type: resultType, loc };
}
