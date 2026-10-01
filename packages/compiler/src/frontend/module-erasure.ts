import * as ts from "./ts7/adapter.js";
import { activeRuntimeTarget } from "../compat/runtime-target.js";

/** Whole-declaration type imports never execute. Node's type stripping
 * retains inline-only clauses as empty runtime imports; Bun elides them.
 * An explicitly empty clause is a runtime edge in both targets. */
export function erasedTypeOnlyImport(stmt: ts.ImportDeclaration): boolean {
  const clause = stmt.importClause;
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  return activeRuntimeTarget().family === "bun" && clause.name === undefined &&
    clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(e => e.isTypeOnly);
}

export function erasedTypeOnlyReexport(stmt: ts.ExportDeclaration): boolean {
  return stmt.isTypeOnly || activeRuntimeTarget().family === "bun" &&
    stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause) &&
    stmt.exportClause.elements.length > 0 && stmt.exportClause.elements.every(e => e.isTypeOnly);
}
