import * as ts from "./ts7/adapter.js";
import { requireSpecOf } from "./require-specifier.js";

/** A narrow process-module member surface, shared by admission and binding
 * recognition. Importing a member never turns the whole module into a
 * general record or relaxes unsupported process APIs. */
function supportedMember(name: string): boolean {
  return name === "env" || name === "versions";
}

export function processModuleMemberImport(stmt: ts.ImportDeclaration): boolean {
  if (!ts.isStringLiteral(stmt.moduleSpecifier) || !["process", "node:process"].includes(stmt.moduleSpecifier.text)) return false;
  const bindings = stmt.importClause?.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.every((binding) =>
    binding.isTypeOnly || supportedMember((binding.propertyName ?? binding.name).text),
  );
}

export function processModuleMemberRequire(decl: ts.VariableDeclaration): boolean {
  if (decl.initializer === undefined || !["process", "node:process"].includes(requireSpecOf(decl.initializer) ?? "")) return false;
  if (!ts.isObjectBindingPattern(decl.name) || (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return false;
  return decl.name.elements.every((element) => {
    if (element.name === undefined || !ts.isIdentifier(element.name) || element.initializer !== undefined || element.dotDotDotToken !== undefined) return false;
    const key = element.propertyName ?? element.name;
    return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && supportedMember(key.text);
  });
}

/** Resolve the binding declaration, not its spelling: renamed imports work,
 * while a parameter or local record shadowing an import stays an ordinary
 * value. Recognition does not materialize process.env as a stale snapshot. */
export function processModuleMemberAliasOf(checker: ts.TypeChecker, expr: ts.Expression): string | null {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr)) return null;
  const symbol = checker.getSymbolAtLocation(expr);
  for (const decl of symbol === undefined ? [] : checker.declarationsOf(symbol)) {
    if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
      const variable = decl.parent.parent;
      if (ts.isVariableDeclaration(variable) && processModuleMemberRequire(variable)) {
        const key = decl.propertyName ?? decl.name;
        if (key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key))) return key.text;
      }
    }
    if (!ts.isImportSpecifier(decl) || decl.isTypeOnly) continue;
    const clause = decl.parent.parent;
    const stmt = clause.parent;
    if (!ts.isImportClause(clause) || !ts.isImportDeclaration(stmt) || stmt.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword || !processModuleMemberImport(stmt)) continue;
    const name = (decl.propertyName ?? decl.name).text;
    if (supportedMember(name)) return name;
  }
  return null;
}
