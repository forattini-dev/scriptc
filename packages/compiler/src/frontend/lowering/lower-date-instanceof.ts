import * as ts from "../ts7/adapter.js";
import { BOOL, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Native Date tags distinguish objects from numeric timestamps without coercion. */
export function lowerNativeDateRegexInstanceof(L: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const kind = L.isStdlibGlobal(expr.right, "Date") ? "date"
    : L.isStdlibGlobal(expr.right, "RegExp") ? "regex" : null;
  if (!kind || L.caughtLocalOf(expr.left)) return null;
  const value = L.lowerExpr(expr.left), loc = locOf(expr);
  if (value.type.kind === "dyn") return kind === "date" ? { kind: "dynTest", test: "date", value, type: BOOL, loc } : null;
  if (value.type.kind === "union") {
    const union = L.unions.get(value.type.unionId);
    const tag = union?.arms.findIndex(arm => arm.kind === kind) ?? -1;
    if (tag >= 0) return { kind: "unionIsTag", unionId: value.type.unionId, tag, value, negated: false, type: BOOL, loc };
  }
  if (value.type.kind === "jsval") return null;
  return { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: { kind: "boolLit", value: value.type.kind === kind, type: BOOL, loc }, type: BOOL, loc };
}
