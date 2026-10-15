import type * as ts from "../ts7/adapter.js";
import { BOOL, isUnitType, type IrExpr, type IrType, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** A compatible callback may need an adapter when ?? chooses a wider callable ABI. */
export function lowerNullishFunction(L: Lowerer, left: IrExpr, right: ts.Expression, target: IrType, loc: SrcLoc): IrExpr | null {
  if (left.type.kind !== "union" || target.kind !== "func") return null;
  const arms = L.unions.get(left.type.unionId)?.arms;
  const present = arms?.filter(arm => !isUnitType(arm));
  if (present?.length !== 1 || present[0]?.kind !== "func") return null;
  const sourceType = present[0];
  // Keep the refusal for adapters that would strand an argument or result.
  if (sourceType.rest || target.rest || sourceType.params.length > target.params.length ||
      sourceType.params.some((param, index) => !target.params[index] || !L.coercibleValue(target.params[index], param)) ||
      (target.ret.kind !== "void" && !L.coercibleValue(sourceType.ret, target.ret))) return null;
  const adapter = L.funcCoerceAdapter(sourceType, target, loc);
  if (!adapter) return null;
  const source = L.declareHiddenLocal("%nullishFunction", left.type);
  const value = varRef(source.id, left.type, loc);
  const tag = L.armTag(left.type.unionId, present[0]);
  const narrowed: IrExpr = { kind: "unionNarrow", value, unionId: left.type.unionId, tag, type: present[0], loc };
  const result: IrExpr = {
    kind: "ternary", cond: { kind: "unionIsTag", value, unionId: left.type.unionId, tag, negated: false, type: BOOL, loc },
    then: { kind: "call", callee: adapter, args: [narrowed], type: target, loc },
    else_: L.lowerExprExpecting(right, target), type: target, loc,
  };
  return { kind: "seqExpr", stmts: [{ kind: "varDecl", localId: source.id, init: left, loc }], result, type: target, loc };
}
