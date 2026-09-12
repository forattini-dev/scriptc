import * as ts from "../ts7/adapter.js";
import { isUnitType } from "../../ir/ir.js";
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

/** The receiver's EXACT runtime class, when the expression proves it: a
 * `new C(...)` expression directly, or a const binding initialized with
 * one (the binding can never be reassigned to a subclass instance).
 * The class is read off the mapped INITIALIZER type — a `const b: Base =
 * new D()` receiver is exactly D, not its annotation. Distinct from
 * exactClassOfReceiver, which answers for CLASS-VALUE receivers. */
export function exactInstanceClassOf(L: Lowerer, expr: ts.Expression): ClassInfo | null {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const classOfNew = (n: ts.Expression): ClassInfo | null => {
    if (!ts.isNewExpression(n)) return null;
    const exact = exactClassOfReceiver(L, n.expression);
    // Ordinary and once-created class values name their concrete runtime
    // class more precisely than the checker result (an Error subclass can
    // otherwise widen to Error). A generic constructor names only its
    // family, so defer that one case to the constructed instance below.
    if (exact && !exact.generic) return exact;
    // The constructed value's type is more precise than the constructor
    // value for generic classes: `new Box(1)` maps to the concrete
    // `Box<number>` instance, while the callee itself names only the
    // generic family. Keep that instance-first rule; the constructor
    // probes below are fallbacks for once-created/optional class values
    // whose checker result has no independently mappable instance type.
    const constructed = L.mapTypeOf(L.typeOf(n));
    if (constructed?.kind === "object") {
      const info = L.classes.get(constructed.className);
      if (info) return info;
    }
    if (exact) return exact;
    if (ts.isIdentifier(n.expression)) {
      // This helper is a read-only inference probe and also runs during
      // collectGlobals, before any function context exists. peekLocal is
      // phase-safe and avoids mutating capture state when called later
      // from expression/member lowering.
      const stored = (L.peekLocal(n.expression) ?? L.globalOf(n.expression))?.type;
      if (stored?.kind === "union") {
        const arms = L.unions.get(stored.unionId)?.arms ?? [];
        const classArms = arms.filter((arm) => arm.kind === "classval");
        const classArm = classArms[0];
        if (
          classArms.length === 1 && classArm !== undefined &&
          arms.every((arm) => arm.kind === "classval" || isUnitType(arm))
        ) {
          return L.classes.get(classArm.className) ?? null;
        }
      }
    }
    return null;
  };
  const direct = classOfNew(e);
  if (direct) return direct;
  if (!ts.isIdentifier(e)) return null;
  const symbol = L.resolveValueSymbol(e);
  const decl = symbol ? L.checker.valueDeclarationOf(symbol) : undefined;
  if (
    !decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  return classOfNew(init);
}

/** Collection asks for storage metadata before the initializer runs. Keep
 * that speculative lookup from flushing a broken class's deferred diagnostic;
 * ordinary statement/expression lowering still resolves with full effects. */
export function probeExactInstanceClassOf(L: Lowerer, expr: ts.Expression): ClassInfo | null {
  const wasCollecting = L.collecting;
  L.collecting = true;
  try {
    return exactInstanceClassOf(L, expr);
  } finally {
    L.collecting = wasCollecting;
  }
}
