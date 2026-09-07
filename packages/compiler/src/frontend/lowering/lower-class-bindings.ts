import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { bindingNeverReassigned } from "./lower-calls.js";

/** The EXACT class a receiver expression is statically known to BE (not
 * merely be typed by): the class name itself, or a stable binding
 * whose initializer is a class expression / class name. Such receivers
 * can never hold a subclass at runtime, so static WRITES through them
 * hit the declaring class's storage exactly (the shadowing hazards of
 * general class values don't arise). Null for everything else. */
export function exactClassOfReceiver(L: Lowerer, expr: ts.Expression): ClassInfo | null {
  if (!ts.isIdentifier(expr)) return null;
  const symbol = L.resolveValueSymbol(expr);
  if (!symbol) return null;
  const direct = L.classBySymbol.get(symbol);
  // A rebindable decorated name is NOT exactly its class — the binding
  // may hold a replacing decorator's result (a subclass value), where a
  // static write would create an own property in JS. The general
  // class-value write fence answers instead.
  if (direct) return direct.classDecorators?.valueGlobalId !== undefined ? null : direct;
  const decl = L.checker.valueDeclarationOf(symbol);
  if (
    !decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent)
  ) {
    return null;
  }
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if ((decl.parent.flags & ts.NodeFlags.Const) === 0) {
    // Bundlers turn declarations into var-bound class expressions. Pin
    // their identity only for a module-level binding with one initializer
    // and no writes, including closures, loops and destructuring targets.
    // Aliases to class values retain the existing const-only boundary.
    if (!ts.isClassExpression(init)) return null;
    const statement = decl.parent.parent;
    if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return null;
    if (L.checker.declarationsOf(symbol).some((d) =>
      d !== decl && ts.isVariableDeclaration(d) && d.initializer !== undefined)) return null;
    if (!bindingNeverReassigned(L, symbol, decl)) return null;
    // Cached speculative collection is not proof the initializer ran.
    if (decl.getSourceFile() === expr.getSourceFile() && expr.getStart() < decl.initializer.end) return null;
  }
  if (ts.isClassExpression(init)) return L.exprClassInfoByNode.get(init) ?? null;
  if (ts.isIdentifier(init)) {
    const initSym = L.resolveValueSymbol(init);
    const aliased = initSym ? (L.classBySymbol.get(initSym) ?? null) : null;
    // `const X = C` over a rebindable decorated name: X holds the
    // decoration result — not exactly C (see the direct case above).
    return aliased?.classDecorators?.valueGlobalId !== undefined ? null : aliased;
  }
  return null;
}
