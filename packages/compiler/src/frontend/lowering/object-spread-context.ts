import * as ts from "../ts7/adapter.js";

/** Context from a final object describes the merge, not each conditional
 * source. Only transparent parentheses and conditional value arms belong
 * to this position; calls, properties and assertions keep their contracts. */
export function isObjectSpreadOperand(node: ts.Expression): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) ||
        (ts.isConditionalExpression(parent) && parent.condition !== current)) {
      current = parent;
      continue;
    }
    return ts.isSpreadAssignment(parent);
  }
}
