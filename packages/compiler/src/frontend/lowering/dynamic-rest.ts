import * as ts from "../ts7/adapter.js";
import { DYN, STRING, VOID, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Complete an open rest slot with a fresh argument vector. Spread iteration
 * happens at its argument position, before later arguments are evaluated. */
export function packDynamicRest(
  lowerer: Lowerer,
  sources: readonly (ts.Expression | { ir: IrExpr })[],
  blame: ts.Node,
  loc: SrcLoc,
): IrExpr {
  const spreadCount = sources.filter((s) => "kind" in s && ts.isSpreadElement(s)).length;
  if (spreadCount === 0) {
    return {
      kind: "dynArrLit",
      elems: sources.map((s) => "kind" in s
        ? lowerer.lowerExprExpecting(s, DYN)
        : lowerer.coerceInto(blame, s.ir, DYN)),
      type: DYN, loc,
    };
  }
  const pack = lowerer.declareHiddenLocal("%rest", DYN);
  const ref = (): IrExpr => ({ kind: "varRef", localId: pack.id, type: DYN, loc });
  const stmts: IrStmt[] = [{
    kind: "varDecl", localId: pack.id,
    init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc,
  }];
  for (const [i, source] of sources.entries()) {
    const node = "kind" in source ? source : undefined;
    const spread = node && ts.isSpreadElement(node) ? node : undefined;
    const at = node ? locOf(node) : loc;
    const value = "ir" in source ? lowerer.coerceInto(blame, source.ir, DYN)
      : lowerer.lowerExprExpecting(spread ? spread.expression : source, DYN);
    const optimized = spread && spreadCount === 1 && i === sources.length - 1;
    const args = [ref(), value];
    if (optimized) args.push({ kind: "strLit", value: spread.expression.getText(), type: STRING, loc: at });
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: spread ? optimized ? "dyn.packPushSpread" : "dyn.packPushSpreadIter" : "dyn.packPush",
        args, type: VOID, loc: at,
      },
      loc: at,
    });
  }
  return { kind: "seqExpr", stmts, result: ref(), type: DYN, loc };
}
