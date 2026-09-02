import * as ts from "../ts7/adapter.js";
import { JSVAL, type IrExpr } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import { lowerIslandObjectLiteral } from "./lower-island.js";
import type { Lowerer } from "./lowerer.js";

/** `new Request(input, init?)` in a dynamic build constructs the Web object
 * inside the embedded realm. */
export function lowerRequestNew(
  L: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (
    !L.dynamic ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "Request"
  ) {
    return null;
  }
  const symbol = L.resolveValueSymbol(expr.expression);
  if (!symbol || !L.isStdlibSymbol(symbol)) return null;
  const args = expr.arguments ?? [];
  if (
    args.length < 1 ||
    args.length > 2 ||
    args.some(ts.isSpreadElement)
  ) {
    return null;
  }
  const loc = locOf(expr);
  const ctor: IrExpr = {
    kind: "jsOp",
    op: "globalGet",
    name: "Request",
    args: [],
    type: JSVAL,
    loc,
  };
  const lowered = args.map((arg) =>
    ts.isObjectLiteralExpression(arg)
      ? lowerIslandObjectLiteral(L, arg)
      : L.jsvalIn(L.lowerExpr(arg), arg),
  );
  return {
    kind: "jsOp",
    op: "construct",
    args: [ctor, ...lowered],
    type: JSVAL,
    loc,
  };
}
