import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { MixinFnShape } from "./lower-mixins.js";

interface ReturnedClass {
  classNode: ts.ClassExpression;
  base: ts.Identifier;
  baseSymbol: ts.Symbol;
}

export interface ClassFactoryMethod extends ReturnedClass {
  declaration: ts.MethodDeclaration;
  closure: ts.VariableDeclaration;
  self?: ts.VariableDeclaration;
}

export interface ClassFactoryShape {
  base: ts.Identifier;
  parameters: readonly ts.ParameterDeclaration[];
  method?: ClassFactoryMethod & { receiver: ts.NewExpression; owner: ts.ClassDeclaration };
}

function unparen(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function plainFunction(fn: MixinFnShape["fn"] | ts.MethodDeclaration): boolean {
  const modifiers: readonly ts.Node[] = fn.modifiers ?? [];
  return !!fn.body && !fn.typeParameters && !fn.asteriskToken &&
    !modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword || m.kind === ts.SyntaxKind.Decorator);
}

/** Recognition is pure: only a known program base, never a runtime-selected base. */
function returnedClassOf(L: Lowerer, expression: ts.Expression): ReturnedClass | null {
  const result = unparen(expression);
  if (!ts.isClassExpression(result) || result.name || result.typeParameters ||
    result.modifiers?.some(m => m.kind === ts.SyntaxKind.Decorator)) return null;
  const heritage = result.heritageClauses;
  if (heritage?.length !== 1 || heritage[0]?.token !== ts.SyntaxKind.ExtendsKeyword ||
    heritage[0].types.length !== 1) return null;
  const base = heritage[0].types[0];
  if (!base || base.typeArguments || !ts.isIdentifier(base.expression)) return null;
  let symbol = L.checker.getSymbolAtLocation(base.expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = L.checker.getAliasedSymbol(symbol);
  const declaration = symbol ? L.checker.valueDeclarationOf(symbol) : undefined;
  if (!symbol || !declaration || !ts.isClassDeclaration(declaration) ||
    !ts.isSourceFile(declaration.parent)) return null;
  return { classNode: result, base: base.expression, baseSymbol: symbol };
}

/** A method retains its receiver through `const closure = this`, optionally
 * assigning the returned class to a local self-reference. No other body effects
 * may disappear into specialization. Ordinary/repeated calls remain fenced. */
export function classFactoryMethodOf(L: Lowerer, declaration: ts.MethodDeclaration): ClassFactoryMethod | null {
  if (!plainFunction(declaration) || !declaration.body || declaration.parameters.length !== 0 ||
    !ts.isIdentifier(declaration.name) ||
    declaration.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) return null;
  const statements = declaration.body.statements;
  if (statements.length !== 2 && statements.length !== 3) return null;
  const first = statements[0];
  const last = statements[statements.length - 1];
  if (!first || !ts.isVariableStatement(first) || !last || !ts.isReturnStatement(last) || !last.expression ||
    (first.declarationList.flags & ts.NodeFlags.Const) === 0 || first.declarationList.declarations.length !== 1) return null;
  const closure = first.declarationList.declarations[0];
  if (!closure || !ts.isIdentifier(closure.name) || !closure.initializer ||
    unparen(closure.initializer).kind !== ts.SyntaxKind.ThisKeyword) return null;
  let expression = unparen(last.expression);
  let self: ts.VariableDeclaration | undefined;
  if (statements.length === 3) {
    const middle = statements[1];
    if (!middle || !ts.isVariableStatement(middle) || (middle.declarationList.flags & ts.NodeFlags.Let) === 0 ||
      middle.declarationList.declarations.length !== 1) return null;
    self = middle.declarationList.declarations[0];
    if (!self || !ts.isIdentifier(self.name) || self.initializer || !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(expression.left) ||
      L.checker.getSymbolAtLocation(expression.left) !== L.checker.getSymbolAtLocation(self.name)) return null;
    expression = unparen(expression.right);
  }
  const returned = returnedClassOf(L, expression);
  return returned ? { ...returned, declaration, closure, ...(self ? { self } : {}) } : null;
}

/** A direct wrapper delegates to an own method on an exact newly constructed
 * receiver. No virtual dispatch, method arguments, chains, or extra statements
 * are guessed. Construction itself still lowers at the outer call site. */
function wrapperMethodOf(L: Lowerer, result: ts.Expression): ClassFactoryShape["method"] | null {
  const call = unparen(result);
  if (!ts.isCallExpression(call) || call.arguments.length !== 0 || call.typeArguments || call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) || call.expression.questionDotToken) return null;
  const receiver = unparen(call.expression.expression);
  if (!ts.isNewExpression(receiver) || receiver.typeArguments || !ts.isIdentifier(receiver.expression)) return null;
  // These belong to the wrapper's invocation frame, not the top-level
  // specialization site. Do not replace them with that site's ambient frame.
  let invocationFrame = false;
  ts.walkPreorder(receiver, node => {
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword ||
      ts.isMetaProperty(node) || (ts.isIdentifier(node) && node.text === "arguments")) {
      invocationFrame = true;
      return "stop";
    }
    return undefined;
  });
  if (invocationFrame) return null;
  let symbol = L.checker.getSymbolAtLocation(receiver.expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = L.checker.getAliasedSymbol(symbol);
  const owner = symbol ? L.checker.valueDeclarationOf(symbol) : undefined;
  if (!owner || !ts.isClassDeclaration(owner) || !ts.isSourceFile(owner.parent) || owner.typeParameters ||
    owner.modifiers?.some(m => m.kind === ts.SyntaxKind.Decorator)) return null;
  const name = call.expression.name.text;
  const members = owner.members.filter(m => (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) ||
    ts.isGetAccessor(m) || ts.isSetAccessor(m)) && ts.isIdentifier(m.name) && m.name.text === name);
  const member = members[0];
  if (members.length !== 1 || !member || !ts.isMethodDeclaration(member)) return null;
  const method = classFactoryMethodOf(L, member);
  return method ? { ...method, owner, receiver } : null;
}

export function closedClassFactoryShapeOf(L: Lowerer, fn: MixinFnShape["fn"]): MixinFnShape | null {
  if (!plainFunction(fn) || !fn.body) return null;
  let result: ts.Expression | undefined;
  if (ts.isBlock(fn.body)) {
    const statement = fn.body.statements[0];
    if (fn.body.statements.length !== 1 || !statement || !ts.isReturnStatement(statement)) return null;
    result = statement.expression;
  } else result = fn.body;
  if (!result) return null;
  const method = wrapperMethodOf(L, result);
  const returned = method ?? returnedClassOf(L, result);
  if (!returned) return null;
  const name = (ts.isFunctionDeclaration(fn) ? fn.name?.text : undefined) ??
    (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : "%anon");
  return { fn, paramSym: returned.baseSymbol, paramTypeParam: null, classNode: returned.classNode, name,
    factory: { base: returned.base, parameters: fn.parameters, ...(method ? { method } : {}) } };
}
