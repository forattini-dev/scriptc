import type { Lowerer } from "./lowerer.js";
import * as ts from "../ts7/adapter.js";

/** Calls whose result is ignored: ordinary expression statements and
 * concise arrow bodies (whose contextual void result is discarded). */
export function resultIsDiscarded(call: ts.CallExpression): boolean {
  return ts.isExpressionStatement(call.parent) || ts.isArrowFunction(call.parent);
}

/** VOID/never results are usable as statements and concise arrow bodies
 * only (the lower-dgram stance): nothing downstream can consume them. */
export function requireStatementPosition(lowerer: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  lowerer.noLowering(
    `using the result of ${what}`,
    call,
    "the result is void — call it as its own statement",
  );
}
