import * as ts from "../ts7/adapter.js";
import { isCjsJsFile, npmStaticDepSf7, requireSpecOf, resolveImport } from "../program.js";
import { createRequireProgramModuleOf } from "./lower-builtins.js";
import type { Lowerer } from "./lowerer.js";

/** Default CJS imports and whole-module require bindings load the same
 * module.exports value. Resolve program aliases and opted-in npm entries
 * through the same source graph, not through a package-name special case. */
export function localModuleBindingDepOf(lowerer: Lowerer, expr: ts.Identifier): ts.SourceFile | null {
  const symbol = lowerer.checker.getSymbolAtLocation(expr);
  const declarations = symbol ? lowerer.checker.declarationsOf(symbol) : [];
  const decl = declarations.find(ts.isImportClause) ?? declarations[0];
  if (!decl) return null;
  let importDecl: ts.ImportDeclaration | undefined;
  if (ts.isImportClause(decl) && ts.isImportDeclaration(decl.parent)) importDecl = decl.parent;
  if (ts.isImportSpecifier(decl) && (decl.propertyName ?? decl.name).text === "default") {
    const parent = decl.parent.parent.parent;
    if (ts.isImportDeclaration(parent)) importDecl = parent;
  }
  if (importDecl && ts.isStringLiteral(importDecl.moduleSpecifier)) {
    const spec = importDecl.moduleSpecifier.text;
    const dep = resolveImport(lowerer.program, importDecl.getSourceFile(), spec) ??
      npmStaticDepSf7(lowerer.program, importDecl.getSourceFile(), spec);
    return dep && isCjsJsFile(dep) ? dep : null;
  }
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return null;
  const directSpec = requireSpecOf(decl.initializer);
  if (directSpec !== null) {
    const dep = resolveImport(lowerer.program, decl.getSourceFile(), directSpec) ??
      npmStaticDepSf7(lowerer.program, decl.getSourceFile(), directSpec);
    return dep?.fileName.endsWith(".json") === true ? null : dep;
  }
  return createRequireProgramModuleOf(lowerer, decl.initializer)?.dep ?? null;
}
