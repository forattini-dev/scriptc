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

function moduleExports(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression) && !expression.questionDotToken &&
    ts.isIdentifier(expression.expression) && expression.expression.text === "module" && expression.name.text === "exports";
}

function exportReceiver(expression: ts.Expression): boolean {
  return (ts.isIdentifier(expression) && expression.text === "exports") || moduleExports(expression);
}

function exportStoreTarget(expression: ts.Expression): boolean {
  if (moduleExports(expression)) return true;
  if (ts.isPropertyAccessExpression(expression) && !expression.questionDotToken) {
    return expression.name.text !== "__proto__" && exportReceiver(expression.expression);
  }
  return ts.isElementAccessExpression(expression) && !expression.questionDotToken &&
    ts.isStringLiteralLike(expression.argumentExpression) && expression.argumentExpression.text !== "__proto__" &&
    exportReceiver(expression.expression);
}

function literalData(expression: ts.Expression): boolean {
  return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isVoidExpression(expression) && ts.isNumericLiteral(expression.expression));
}

/** A syntactic store, not an execution edge. The receiver must additionally
 * be proven unescaped below before this may prune the TDZ traversal. */
function passiveExportStore(expression: ts.Expression, hoisted: ReadonlyMap<ts.Symbol, ts.Statement>, checker: ts.TypeChecker): boolean {
  let value = expression;
  let assignment = false;
  while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (!exportStoreTarget(value.left)) return false;
    assignment = true;
    value = value.right;
  }
  if (!assignment) return false;
  if (literalData(value)) return true;
  if (!ts.isIdentifier(value)) return false;
  const symbol = checker.getSymbolAtLocation(value);
  const declaration = symbol === undefined ? undefined : hoisted.get(symbol);
  return declaration !== undefined && ts.isFunctionDeclaration(declaration) && declaration.body !== undefined;
}

function dataExportDescriptor(expression: ts.Expression, checker: ts.TypeChecker, source: ts.SourceFile): boolean {
  if (!ts.isCallExpression(expression) || expression.questionDotToken || expression.arguments.length !== 3 ||
      !ts.isPropertyAccessExpression(expression.expression) || expression.expression.questionDotToken ||
      !ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== "Object" ||
      expression.expression.name.text !== "defineProperty") return false;
  const objectSymbol = checker.getSymbolAtLocation(expression.expression.expression);
  if (objectSymbol !== undefined && checker.declarationsOf(objectSymbol).some(declaration => declaration.getSourceFile().fileName === source.fileName)) return false;
  const [receiver, key, descriptor] = expression.arguments;
  if (receiver === undefined || key === undefined || descriptor === undefined || !exportReceiver(receiver) ||
      !ts.isStringLiteralLike(key) || !ts.isObjectLiteralExpression(descriptor)) return false;
  return descriptor.properties.every(property => ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
    ["value", "writable", "enumerable", "configurable"].includes(property.name.text) && literalData(property.initializer));
}

/** Export assignment can invoke an inherited setter too. Treat mutation or
 * escape of the ambient objects/prototypes as loss of the fresh-data proof;
 * ordinary builtin reads (including hasOwnProperty.call) do not lose it. */
function ambientExportMutation(node: ts.Identifier): boolean {
  if (node.text !== "Object" && node.text !== "Function") return false;
  let access: ts.Expression = node;
  let prototype = false;
  while ((ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)) && access.parent.expression === access) {
    access = access.parent;
    if (ts.isPropertyAccessExpression(access) && access.name.text === "prototype") prototype = true;
    if (ts.isElementAccessExpression(access)) return true;
  }
  const parent = access.parent;
  if ((ts.isBinaryExpression(parent) && parent.left === access &&
       parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent) || ts.isDeleteExpression(parent)) return true;
  if (ts.isCallExpression(parent) && parent.expression === access) {
    if (!prototype) return false;
    const method = ts.isPropertyAccessExpression(access) && access.name.text === "call" ? access.expression : access;
    return !ts.isPropertyAccessExpression(method) || !["hasOwnProperty", "propertyIsEnumerable", "toString"].includes(method.name.text);
  }
  return access === node || prototype;
}

/** Native CommonJS exports start as data properties. Keep that proof only
 * while the prefix does not expose/replace the receiver or install accessors.
 * Follow referenced local declarations too: a helper can capture exports
 * without taking it as an argument. Unknown receiver uses retain refusal. */
function unescapedExportPrefix(source: ts.SourceFile, index: number, checker: ts.TypeChecker, hoisted: ReadonlyMap<ts.Symbol, ts.Statement>, isSelfRequire: (specifier: string) => boolean): boolean {
  const work: ts.Statement[] = source.statements.slice(0, index).filter(statement => !ts.isFunctionDeclaration(statement));
  const scanned = new Set<ts.Statement>(work);
  let safe = true;
  while (safe && work.length > 0) {
    checker.prefetchSymbolRoots(work);
    const statement = work.pop();
    if (statement === undefined) continue;
    ts.walkPreorder(statement, node => {
      const specifier = requireSpecOf(node);
      if (specifier !== null && isSelfRequire(specifier)) { safe = false; return "stop"; }
      if (ts.isExpressionStatement(node) &&
          (passiveExportStore(node.expression, hoisted, checker) || dataExportDescriptor(node.expression, checker, source))) return "skip";
      if (!ts.isIdentifier(node)) return undefined;
      if (node.text === "exports" || node.text === "module" || ambientExportMutation(node)) { safe = false; return "stop"; }
      const symbol = checker.getSymbolAtLocation(node);
      const target = symbol === undefined ? undefined : hoisted.get(symbol);
      if (target !== undefined && !scanned.has(target)) { scanned.add(target); work.push(target); }
      return undefined;
    });
  }
  return safe;
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
export function requireTdzRisk(program: ts.Program, source: ts.SourceFile, index: number, declaration: ts.VariableDeclaration, commonJs: boolean, isSelfRequire: (specifier: string) => boolean): string | null {
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
  checker.prefetchSymbolRoots(statements.slice(0, index).filter((statement) => !ts.isFunctionDeclaration(statement)));
  const passiveStores = commonJs && unescapedExportPrefix(source, index, checker, hoisted, isSelfRequire);
  const scan = (root: ts.Node): void => {
    // Keep the iterative walk: deeply nested binders must reach diagnostics.
    ts.walkPreorder(root, (node) => {
      if (passiveStores && ts.isExpressionStatement(node) && passiveExportStore(node.expression, hoisted, checker)) return "skip";
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
