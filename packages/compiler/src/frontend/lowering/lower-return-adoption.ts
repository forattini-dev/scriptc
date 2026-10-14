import type * as ts from "../ts7/adapter.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Convert the settled representation through a non-scheduling promise view.
 * The return itself then adopts that promise after any enclosing finally. */
export function lowerReturnAdoption(L: Lowerer, node: ts.Node, promise: IrExpr, result: IrType): IrExpr {
  const source = L.coerceInto(node, promise, { kind: "promise", inner: result });
  return { kind: "awaitExpr", adopt: true, value: source, type: result, loc: promise.loc };
}
