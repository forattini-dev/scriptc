import * as ts from "../ts7/adapter.js";
import { BOOL, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Native object tags distinguish branded values and collections without coercion. */
export function lowerNativeDateRegexInstanceof(L: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const kind = L.isStdlibGlobal(expr.right, "Date") ? "date"
    : L.isStdlibGlobal(expr.right, "RegExp") ? "regex"
    : L.isStdlibGlobal(expr.right, "URL") ? "url"
    : L.isStdlibGlobal(expr.right, "Map") ? "map"
    : L.isStdlibGlobal(expr.right, "Set") ? "set"
    : L.isStdlibGlobal(expr.right, "URLSearchParams") ? "searchParams" : null;
  if (!kind || L.caughtLocalOf(expr.left)) return null;
  const value = L.lowerExpr(expr.left), loc = locOf(expr);
  if (value.type.kind === "dyn") {
    if (kind === "date") return { kind: "dynTest", test: "date", value, type: BOOL, loc };
    if (L.nativeDynamicBuiltinInstanceof) return { kind: "dynTest", test: kind, value, type: BOOL, loc };
    return null;
  }
  if (value.type.kind === "union") {
    const union = L.unions.get(value.type.unionId);
    const tag = union?.arms.findIndex(arm => arm.kind === kind) ?? -1;
    if (tag >= 0) return { kind: "unionIsTag", unionId: value.type.unionId, tag, value, negated: false, type: BOOL, loc };
  }
  if (value.type.kind === "jsval") return null;
  return { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: { kind: "boolLit", value: value.type.kind === kind, type: BOOL, loc }, type: BOOL, loc };
}
