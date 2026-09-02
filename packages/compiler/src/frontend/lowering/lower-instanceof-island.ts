import * as ts from "../ts7/adapter.js";
import { BOOL, JSVAL, type IrExpr, type SrcLoc } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** A Web constructor implemented by the embedded realm must perform
 * InstanceofOperator in that same realm. The global lookup stays dynamic,
 * so replacing globalThis.Request remains observable like it is in Node. */
export function lowerDynamicRequestInstanceOf(
  L: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (
    !L.dynamic ||
    !ts.isIdentifier(expr.right) ||
    !L.isStdlibGlobal(expr.right, "Request") ||
    L.caughtLocalOf(expr.left)
  ) {
    return null;
  }
  const left = L.jsvalIn(L.lowerExpr(expr.left), expr.left);
  const right: IrExpr = {
    kind: "jsOp",
    op: "globalGet",
    name: "Request",
    args: [],
    type: JSVAL,
    loc,
  };
  return {
    kind: "jsOp",
    op: "instanceOf",
    args: [left, right],
    type: BOOL,
    loc,
  };
}
