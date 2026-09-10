import * as ts from "./ts7/adapter.js";
import { DYN, type IrType } from "../ir/nodes.js";
import { isJsSourceFile } from "./program.js";
import type { TypeMapperCtx } from "./types.js";

/** JS object fields initialized with empty arrays can accumulate values.
 * Their inferred never element is inference residue, not a numeric ABI.
 * Declared interfaces/JSDoc members and TS literals keep their contracts. */
export function mapJsArrayField(symbol: ts.Symbol, type: ts.Type, ctx: TypeMapperCtx, map: (type: ts.Type) => IrType | null): IrType | null {
  const declaration = ctx.checker.valueDeclarationOf(symbol);
  if (!declaration || !(ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration))) return null;
  const initializer = ts.isPropertyAssignment(declaration) ? declaration.initializer
    : ts.isIdentifier(declaration.name) ? declaration.name : null;
  if (!initializer) return null;
  const contextual = ts.isPropertyAssignment(declaration) ? ctx.checker.getContextualType(initializer) : undefined;
  if (contextual && ctx.checker.isArrayType(contextual) && !hasNeverElement(contextual, ctx.checker)) return map(contextual);
  return hasNeverElement(type, ctx.checker) && inferredJsArrayOrigin(initializer, ctx.checker) ? DYN : null;
}

/** Aliases of inferred JS arrays and their search/removal results keep
 * dynamic storage instead of numeric arrays or checker-undefined slots. */
export function jsArrayInferenceBinding(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(node)) return false;
  const type = checker.getTypeAtLocation(node);
  const arrayResidue = hasNeverElement(type, checker);
  if (!arrayResidue && !(type.flags & (ts.TypeFlags.Never | ts.TypeFlags.Undefined))) return false;
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol && checker.valueDeclarationOf(symbol);
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.type || !declaration.initializer) return false;
  const init = declaration.initializer;
  if (arrayResidue) return inferredJsArrayOrigin(init, checker);
  if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression) ||
    !["find", "findLast", "pop", "shift", "at"].includes(init.expression.name.text) || checker.getContextualType(init)) return false;
  const receiver = init.expression.expression;
  return hasNeverElement(checker.getTypeAtLocation(receiver), checker) && inferredJsArrayOrigin(receiver, checker);
}

/** TS forwarding expressions can carry the same JS inference residue. */
export function jsArrayInferenceExpression(node: ts.Node, checker: ts.TypeChecker): boolean {
  return (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    hasNeverElement(checker.getTypeAtLocation(node), checker) && inferredJsArrayOrigin(node, checker);
}

/** Follow aliases and field reads to the empty JS array declaration; TS
 * annotations and unrelated never[] sources do not acquire this fallback. */
function inferredJsArrayOrigin(node: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): boolean {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  if (ts.isArrayLiteralExpression(node)) return isJsSourceFile(node.getSourceFile());
  if (ts.isElementAccessExpression(node) && checker.isArrayType(checker.getTypeAtLocation(node.expression))) {
    return inferredJsArrayOrigin(node.expression, checker, seen);
  }
  const symbol = ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node.name)
    : ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  let declaration = checker.valueDeclarationOf(symbol);
  if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
    const value = checker.getShorthandAssignmentValueSymbol(declaration);
    declaration = value && checker.valueDeclarationOf(value);
  }
  if (!declaration || !(ts.isPropertyAssignment(declaration) || ts.isVariableDeclaration(declaration))) return false;
  if (ts.isVariableDeclaration(declaration) && declaration.type) return false;
  const init = declaration.initializer;
  return !!init && inferredJsArrayOrigin(init, checker, seen);
}

function hasNeverElement(type: ts.Type, checker: ts.TypeChecker): boolean {
  const seen = new Set<ts.Type>();
  while (checker.isArrayType(type) && !seen.has(type)) {
    seen.add(type);
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    if (!element) return false;
    if (element.flags & ts.TypeFlags.Never) return true;
    type = element;
  }
  return false;
}
