import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, F64, type IrExpr } from "../../ir/ir.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";

export function relationalOperator(op: ts.SyntaxKind): "<" | "<=" | ">" | ">=" | undefined {
  switch (op) {
    case ts.SyntaxKind.LessThanToken: return "<";
    case ts.SyntaxKind.LessThanEqualsToken: return "<=";
    case ts.SyntaxKind.GreaterThanToken: return ">";
    case ts.SyntaxKind.GreaterThanEqualsToken: return ">=";
    default: return undefined;
  }
}

/** Keep homogeneous primitive fast paths. The dynamic call evaluates both
 * operands before coercion and preserves undefined from optional reads. */
export function lowerNativeRelational(
  L: Lowerer, op: "<" | "<=" | ">" | ">=", left: IrExpr, right: IrExpr,
): IrExpr | null {
  if (left.type.kind === right.type.kind && ["f64", "string"].includes(left.type.kind)) return null;
  const box = (value: IrExpr): IrExpr | null => value.type.kind === "dyn" ? value
    : value.type.kind === "void" ? {
      kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
      result: dynUndefinedExpr(value.loc), type: DYN, loc: value.loc,
    } : L.dynConvertible(value.type) ? L.coerceToExpected(value, DYN) : null;
  const l = box(left), r = box(right);
  if (!l || !r) return null;
  const loc = left.loc;
  return {
    kind: "bin", op,
    left: { kind: "libCall", fn: "dyn.compare", args: [l, r], type: F64, loc },
    right: { kind: "numLit", value: 0, type: F64, loc }, type: BOOL, loc,
  };
}
