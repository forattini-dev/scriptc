import * as ts from "./ts7/adapter.js";

/** Remove syntax-only wrappers without changing the expression's runtime value. */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A statically named property. Dynamic keys stay behind the cycle fence. */
function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
  }
  return null;
}

/** Split `root["lane"].maxBytes` into its root identifier and literal keys. */
function propertyChain(
  expression: ts.Expression,
): { root: ts.Identifier; keys: string[] } | null {
  const keys: string[] = [];
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      keys.unshift(current.name.text);
    } else {
      const argument = current.argumentExpression === undefined
        ? null
        : unwrapExpression(current.argumentExpression);
      if (argument === null || (!ts.isStringLiteral(argument) && !ts.isNumericLiteral(argument))) {
        return null;
      }
      keys.unshift(argument.text);
    }
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) && keys.length > 0
    ? { root: current, keys }
    : null;
}

/** Follow an exact path through ordinary object-literal data properties. */
function objectLiteralValue(
  initializer: ts.Expression,
  keys: readonly string[],
): ts.Expression | null {
  let current = unwrapExpression(initializer);
  for (const key of keys) {
    if (!ts.isObjectLiteralExpression(current)) return null;
    const property = current.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === key,
    );
    if (property === undefined) return null;
    current = unwrapExpression(property.initializer);
  }
  return current;
}

function constInitializerOf(
  checker: ts.TypeChecker,
  root: ts.Identifier,
  keys: readonly string[],
  acceptSource: (source: ts.SourceFile) => boolean,
): ts.Expression | null {
  let symbol = checker.getSymbolAtLocation(root);
  if (symbol === undefined) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);

  for (const declaration of checker.declarationsOf(symbol)) {
    if (
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      acceptSource(declaration.getSourceFile())
    ) {
      const value = objectLiteralValue(declaration.initializer, keys);
      if (value !== null) return value;
    }
  }
  return null;
}

/**
 * True when `expression` only reads data properties from a const object literal
 * initialized outside the current ESM cycle.
 *
 * An imported dependency outside the SCC has completed evaluation before the
 * cycle starts. Walking explicit object-literal properties therefore cannot
 * invoke a getter or observe a partially initialized binding. Spreads,
 * accessors, computed runtime keys, and declarations inside the SCC are kept
 * behind SC1016.
 */
export function isPreinitializedDataPropertyRead(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  cycleMembers: ReadonlySet<ts.SourceFile>,
): boolean {
  const chain = propertyChain(expression);
  if (chain === null) return false;
  return constInitializerOf(
    checker,
    chain.root,
    chain.keys,
    (source) => !cycleMembers.has(source),
  ) !== null;
}

/**
 * The leaf initializer behind an imported const object's literal property
 * chain, or null. Callers may inline it only after independently proving the
 * leaf expression is side-effect-free.
 */
export function externalStaticDataPropertyInitializer(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Expression | null {
  const chain = propertyChain(expression);
  if (chain === null) return null;
  const useSource = expression.getSourceFile();
  return constInitializerOf(
    checker,
    chain.root,
    chain.keys,
    (source) => source !== useSource,
  );
}
