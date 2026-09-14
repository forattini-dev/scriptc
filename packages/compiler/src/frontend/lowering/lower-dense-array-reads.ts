import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { hasOptionalIndexContext } from "./lower-contextual-index.js";

/** Dense native arrays (the Rust lane) keep the typed read contract: an
 * ordinary `xs[i]` is the element ABI, and only reads whose consumer
 * observes absence keep the `T | undefined` union — optional-index
 * contexts, fresh/probe results (`filter(...)[0]`, `slice(-1)[0]`), and
 * inferred block-local bindings. */
export function denseArrayReadObservesAbsence(L: Lowerer, expr: ts.ElementAccessExpression): boolean {
  return isFreshArrayProbe(expr.expression) || isRuntimeOptionalArrayBinding(L, expr) || hasOptionalIndexContext(L, expr);
}

function isFreshArrayProbe(node: ts.Expression): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    (current.expression.name.text === "filter" ||
      current.expression.name.text === "slice" ||
      current.expression.name.text === "sort")
  );
}

/** An inferred block-local array read retains its hidden undefined arm;
 * explicit annotations, globals, and hoisted vars keep their contract. */
function isRuntimeOptionalArrayBinding(L: Lowerer, node: ts.Expression): boolean {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isTypeAssertion(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  const declaration = current.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== current ||
    declaration.type !== undefined ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent)
  ) {
    return false;
  }
  const list = declaration.parent;
  if ((list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) return false;
  const symbol = L.checker.getSymbolAtLocation(declaration.name);
  return symbol !== undefined && !L.globalsBySymbol.has(symbol);
}
