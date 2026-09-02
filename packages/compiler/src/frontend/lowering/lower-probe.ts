import type { IrExpr } from "../../ir/nodes.js";
import * as ts from "../ts7/adapter.js";
import { PoisonError, type Lowerer } from "./lowerer.js";

/**
 * Lower an expression speculatively, discarding the diagnostic emitted by a
 * declined lowering while preserving diagnostics from a successful probe.
 */
export function probeLower(L: Lowerer, node: ts.Expression): IrExpr | null {
  const saved = L.diagSink;
  const captured: typeof L.diags = [];
  L.diagSink = captured;
  let result: IrExpr | null;
  try {
    result = L.lowerExpr(node);
  } catch (error) {
    if (error instanceof PoisonError) {
      L.diagSink = saved;
      return null;
    }
    L.diagSink = saved;
    throw error;
  }
  L.diagSink = saved;
  for (const diagnostic of captured) L.pushDiag(diagnostic);
  return result;
}
