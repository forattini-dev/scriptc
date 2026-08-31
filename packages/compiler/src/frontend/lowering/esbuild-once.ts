/* Recognition for esbuild's lazy ESM initializer. The callback passed to
 * this helper is evaluated at most once even when the returned initializer
 * is called repeatedly: the helper clears the callback before invoking it.
 * This proof lets once-created values keep an ordinary static IR identity. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

function stripParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function namesSymbol(L: Lowerer, node: ts.Node, symbol: ts.Symbol): boolean {
  return ts.isIdentifier(node) && L.resolveValueSymbol(node) === symbol;
}

function targetNamesSymbol(L: Lowerer, node: ts.Node, symbol: ts.Symbol): boolean {
  if (namesSymbol(L, node, symbol)) return true;
  if (!ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node)) return false;
  let found = false;
  node.forEachChild((child) => {
    if (!found && targetNamesSymbol(L, child, symbol)) found = true;
  });
  return found;
}

function bindingNeverWrittenAfterInit(L: Lowerer, symbol: ts.Symbol, decl: ts.VariableDeclaration): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment &&
        targetNamesSymbol(L, node.left, symbol)
      ) {
        written = true;
        return;
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      targetNamesSymbol(L, node.operand, symbol)
    ) {
      written = true;
      return;
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      targetNamesSymbol(L, node.initializer, symbol)
    ) {
      written = true;
      return;
    }
    node.forEachChild(visit);
  };
  decl.getSourceFile().forEachChild(visit);
  return !written;
}

function topLevelInitializerCall(call: ts.CallExpression): boolean {
  let value: ts.Expression = call;
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  const decl = value.parent;
  return (
    ts.isVariableDeclaration(decl) &&
    decl.initializer === value &&
    ts.isVariableDeclarationList(decl.parent) &&
    ts.isVariableStatement(decl.parent.parent) &&
    ts.isSourceFile(decl.parent.parent.parent)
  );
}

function isClearingOnceFactory(L: Lowerer, callee: ts.Expression): boolean {
  const target = stripParens(callee);
  if (!ts.isIdentifier(target)) return false;
  const symbol = L.resolveValueSymbol(target);
  const decl = symbol ? L.checker.valueDeclarationOf(symbol) : undefined;
  if (
    !symbol ||
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    !ts.isVariableStatement(decl.parent.parent) ||
    !ts.isSourceFile(decl.parent.parent.parent) ||
    !bindingNeverWrittenAfterInit(L, symbol, decl)
  ) {
    return false;
  }

  const outer = stripParens(decl.initializer);
  if (!ts.isArrowFunction(outer) || outer.parameters.length !== 2) return false;
  const factoryParam = outer.parameters[0];
  const valueParam = outer.parameters[1];
  if (!factoryParam || !valueParam || !ts.isIdentifier(factoryParam.name) || !ts.isIdentifier(valueParam.name)) {
    return false;
  }
  const factorySymbol = L.checker.getSymbolAtLocation(factoryParam.name);
  const valueSymbol = L.checker.getSymbolAtLocation(valueParam.name);
  if (!factorySymbol || !valueSymbol) return false;

  const inner = ts.isBlock(outer.body) ? null : stripParens(outer.body);
  if (!inner || !ts.isArrowFunction(inner) || inner.parameters.length !== 0 || ts.isBlock(inner.body)) return false;
  const sequence = stripParens(inner.body);
  if (!ts.isBinaryExpression(sequence) || sequence.operatorToken.kind !== ts.SyntaxKind.CommaToken) return false;
  if (!namesSymbol(L, stripParens(sequence.right), valueSymbol)) return false;

  const guarded = stripParens(sequence.left);
  if (
    !ts.isBinaryExpression(guarded) ||
    guarded.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
    !namesSymbol(L, stripParens(guarded.left), factorySymbol)
  ) {
    return false;
  }
  const save = stripParens(guarded.right);
  if (
    !ts.isBinaryExpression(save) ||
    save.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !namesSymbol(L, stripParens(save.left), valueSymbol)
  ) {
    return false;
  }
  const invoke = stripParens(save.right);
  if (
    !ts.isCallExpression(invoke) ||
    !namesSymbol(L, stripParens(invoke.expression), factorySymbol) ||
    invoke.arguments.length !== 1
  ) {
    return false;
  }
  const clearArg = invoke.arguments[0];
  if (!clearArg) return false;
  const clear = stripParens(clearArg);
  return (
    ts.isBinaryExpression(clear) &&
    clear.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    namesSymbol(L, stripParens(clear.left), factorySymbol) &&
    ts.isNumericLiteral(stripParens(clear.right)) &&
    Number((stripParens(clear.right) as ts.NumericLiteral).text) === 0
  );
}

/** True only for a class directly inside the callback passed to a canonical
 * esbuild once initializer created at module scope. Nested methods/functions
 * deliberately fail: their class expressions can still evaluate repeatedly. */
export function classExpressionRunsOnceInEsbuildInitializer(
  L: Lowerer,
  expr: ts.ClassExpression,
): boolean {
  let owner: ts.Node = expr.parent;
  while (!ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  if (!ts.isArrowFunction(owner) || owner.parameters.length !== 0) return false;

  let callback: ts.Expression = owner;
  while (ts.isParenthesizedExpression(callback.parent)) callback = callback.parent;
  const call = callback.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === callback &&
    topLevelInitializerCall(call) &&
    isClearingOnceFactory(L, call.expression)
  );
}

/** The sole class value assigned to an uninitialized module binding by a
 * canonical esbuild once callback. The binding remains a real runtime slot:
 * it starts as undefined and receives the class object when the initializer
 * first runs. Any second producer or non-simple write declines the proof. */
export function esbuildOnceAssignedClassExpression(
  L: Lowerer,
  decl: ts.VariableDeclaration,
): ts.ClassExpression | null {
  if (
    !ts.isIdentifier(decl.name) || decl.initializer !== undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    !ts.isVariableStatement(decl.parent.parent) ||
    !ts.isSourceFile(decl.parent.parent.parent)
  ) {
    return null;
  }
  const symbol = L.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return null;

  let candidate: ts.ClassExpression | null = null;
  let invalidWrite = false;
  ts.walkPreorder(decl.getSourceFile(), (node) => {
    if (invalidWrite) return "skip";
    if (ts.isVariableDeclaration(node) && node !== decl && ts.isIdentifier(node.name)) {
      if (L.checker.getSymbolAtLocation(node.name) === symbol && node.initializer !== undefined) {
        invalidWrite = true;
        return "skip";
      }
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment &&
        targetNamesSymbol(L, node.left, symbol)
      ) {
        let rhs = node.right;
        while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
        if (
          op !== ts.SyntaxKind.EqualsToken || !ts.isClassExpression(rhs) ||
          candidate !== null || !classExpressionRunsOnceInEsbuildInitializer(L, rhs)
        ) {
          invalidWrite = true;
        } else {
          candidate = rhs;
        }
        return "skip";
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      targetNamesSymbol(L, node.operand, symbol)
    ) {
      invalidWrite = true;
      return "skip";
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      targetNamesSymbol(L, node.initializer, symbol)
    ) {
      invalidWrite = true;
      return "skip";
    }
    return undefined;
  });
  return invalidWrite ? null : candidate;
}
