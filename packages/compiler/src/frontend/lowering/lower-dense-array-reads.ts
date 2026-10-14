import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { hasOptionalIndexContext } from "./lower-contextual-index.js";
import { inferredLambdaRead } from "./lambda-read-result.js";
export { lowerArrayElementReceiver } from "./lower-array-element-receiver.js";

/** Dense native arrays (the Rust lane) keep the typed read contract: an
 * ordinary `xs[i]` is the element ABI, and only reads whose consumer
 * observes absence keep the `T | undefined` union — optional-index
 * contexts, fresh/probe results (`filter(...)[0]`, `slice(-1)[0]`), and
 * inferred block-local bindings, direct member receivers, and values
 * copied into another array slot or used as a search needle. */
export function denseArrayReadObservesAbsence(L: Lowerer, expr: ts.ElementAccessExpression): boolean {
  const lambda = inferredLambdaRead(expr);
  if (lambda && L.runtimeOptionalFunctionReturns.has(lambda)) return true;
  return isMemberReceiver(expr) || isObservedValue(L, expr) || isArrayElementStoreValue(L, expr) || isFreshArrayProbe(expr.expression) || isRuntimeOptionalArrayBinding(L, expr) || hasOptionalIndexContext(L, expr);
}

function isObservedValue(L: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  if (ts.isArrayLiteralExpression(node.parent)) return true;
  const call = node.parent;
  return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
    call.arguments.includes(node) && L.isStdlibGlobal(call.expression.expression, "console") &&
    ["log", "info", "warn", "error", "debug"].includes(call.expression.name.text);
}

/** Arithmetic must receive the optional value before ToNumber turns absence into NaN. */
export function numericReadObservesAbsence(node: ts.Node): boolean {
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.PlusToken || parent.operator === ts.SyntaxKind.MinusToken || parent.operator === ts.SyntaxKind.TildeToken;
  return ts.isBinaryExpression(parent) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken,
    ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken].includes(parent.operatorToken.kind);
}

function isMemberReceiver(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node;
}

/** Array storage can represent present undefined without widening its payload ABI. */
function isArrayElementStoreValue(L: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const assignment = node.parent;
  if (ts.isCallExpression(assignment) && ts.isPropertyAccessExpression(assignment.expression)) {
    const callee = assignment.expression;
    const index = assignment.arguments.indexOf(node);
    const stores = (callee.name.text === "push" || callee.name.text === "unshift") ? index >= 0
      : callee.name.text === "splice" ? index >= 2
      : callee.name.text === "fill" && index === 0;
    const searches = index === 0 && (callee.name.text === "indexOf" || callee.name.text === "lastIndexOf" || callee.name.text === "includes");
    if ((stores || searches) && L.isStdlibMember(callee) && L.mapTypeOf(L.typeOf(callee.expression))?.kind === "array") return true;
  }
  return ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignment.right === node &&
    ts.isElementAccessExpression(assignment.left) &&
    L.mapTypeOf(L.typeOf(assignment.left.expression))?.kind === "array";
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
