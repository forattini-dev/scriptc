import * as ts from "./ts7/adapter.js";
import { requireSpecOf } from "./require-specifier.js";

/** Top-level CommonJS import plumbing also used by global lowering. */
export function isRequireStatement(statement: ts.Statement): boolean {
  if (ts.isExpressionStatement(statement)) return requireSpecOf(statement.expression) !== null;
  if (!ts.isVariableStatement(statement)) return false;
  const declarations = statement.declarationList.declarations;
  return declarations.length > 0 && declarations.every((declaration) =>
    declaration.initializer !== undefined && requireSpecOf(declaration.initializer) !== null);
}

function hoistedFunctionExport(program: ts.Program, statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const assignment = statement.expression;
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(assignment.left) || assignment.left.questionDotToken ||
      !ts.isIdentifier(assignment.left.expression) || assignment.left.expression.text !== "module" ||
      assignment.left.name.text !== "exports" || !ts.isIdentifier(assignment.right)) return false;
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(assignment.right);
  return symbol !== undefined && checker.declarationsOf(symbol).some((declaration) =>
    ts.isFunctionDeclaration(declaration) && declaration.body !== undefined &&
    declaration.getSourceFile().fileName === statement.getSourceFile().fileName);
}

/** These prefixes do not invoke local code. A CommonJS function export
 * stores a hoisted function without invoking its body; cycle admission
 * separately refuses reentrant CommonJS initialization. Any other runnable
 * statement retains the conservative transitive TDZ scan below. */
export function pureRequirePrefixStatement(program: ts.Program, statement: ts.Statement, commonJs: boolean): boolean {
  if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement)) return true;
  if (ts.isExpressionStatement(statement)) {
    if (ts.isStringLiteral(statement.expression) || requireSpecOf(statement.expression) !== null) return true;
    return commonJs && hoistedFunctionExport(program, statement);
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every((declaration) =>
      declaration.initializer === undefined || requireSpecOf(declaration.initializer) !== null ||
      ts.isStringLiteralLike(declaration.initializer) || ts.isNumericLiteral(declaration.initializer) ||
      declaration.initializer.kind === ts.SyntaxKind.TrueKeyword ||
      declaration.initializer.kind === ts.SyntaxKind.FalseKeyword ||
      declaration.initializer.kind === ts.SyntaxKind.NullKeyword);
  }
  return false;
}

/** Earlier runnable statements conservatively reach function values and
 * hoisted declarations transitively. Imports are aliased by native lowering
 * without a TDZ slot, so every reachable early read keeps its refusal. */
export function requireTdzRisk(program: ts.Program, source: ts.SourceFile, index: number, declaration: ts.VariableDeclaration): string | null {
  const checker = program.getTypeChecker();
  const bound: ts.Identifier[] = [];
  if (ts.isIdentifier(declaration.name)) bound.push(declaration.name);
  else if (ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (element.name !== undefined && ts.isIdentifier(element.name)) bound.push(element.name);
    }
  }
  const bindings = new Map<ts.Symbol, string>();
  for (const id of bound) {
    const symbol = checker.getSymbolAtLocation(id);
    if (symbol) bindings.set(symbol, id.text);
  }
  if (bindings.size === 0) return null;
  const statements = source.statements;
  const hoisted = new Map<ts.Symbol, ts.Statement>();
  for (const statement of statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol) hoisted.set(symbol, statement);
    }
  }
  let hit: string | null = null;
  const scanned = new Set<ts.Statement>();
  const work: ts.Statement[] = [];
  const scan = (root: ts.Node): void => {
    // Keep the iterative walk: deeply nested binders must reach diagnostics.
    ts.walkPreorder(root, (node) => {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const name = bindings.get(symbol);
          if (name !== undefined) { hit = name; return "stop"; }
          const target = hoisted.get(symbol);
          if (target && !scanned.has(target)) { scanned.add(target); work.push(target); }
        }
      }
      return undefined;
    });
  };
  checker.prefetchSymbolRoots(statements.slice(0, index).filter((statement) => !ts.isFunctionDeclaration(statement)));
  for (let i = 0; i < index && hit === null; i++) {
    const statement = statements[i];
    if (statement !== undefined && !ts.isFunctionDeclaration(statement)) scan(statement);
  }
  while (hit === null && work.length > 0) {
    checker.prefetchSymbolRoots(work);
    const statement = work.pop();
    if (statement !== undefined) scan(statement);
  }
  return hit;
}
