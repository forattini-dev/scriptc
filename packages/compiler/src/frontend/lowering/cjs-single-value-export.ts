import * as ts from "../ts7/adapter.js";
import { type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** `module.exports = <single value>` — Node's whole-export REPLACEMENT by a
   * non-table value: the requirer's binding IS the value (`const Countdown =
   * require('./countdown'); new Countdown(...)` constructs the class). An
   * identifier naming a program class, function, or immutable global is pure
   * alias plumbing — tsc's export-assignment model makes requirer bindings
   * alias straight to the original declaration symbol, so the class registry,
   * function signatures, and globals all apply unchanged — and the statement
   * lowers to nothing. A scalar-literal value has no declaration for aliases
   * to land on: it assigns the pre-registered export global keyed by this
   * statement (collectGlobals; requirer aliases resolve to the checker's
   * `export=` symbol, whose declaration node IS this statement — globalOf's
   * node fallback). Mutable `let` bindings fence: Node copies the VALUE at
   * this statement, while alias plumbing would read the live binding — the
   * exported-table lowering's rule. Null for every shape beyond the subset
   * (the caller's generic fence). */
export function lowerCjsSingleValueExport(lowerer: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrStmt | null {
    let rhs: ts.Expression = expr.right;
    while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
    if (ts.isIdentifier(rhs)) {
      const sym = lowerer.resolveValueSymbol(rhs);
      if (!sym) return null;
      if (lowerer.classBySymbol.has(sym) || lowerer.fnSigsBySymbol.has(sym) || lowerer.genericFnsBySymbol.has(sym)) {
        return { kind: "block", body: [], loc };
      }
      const g = lowerer.globalsBySymbol.get(sym);
      if (g) {
        if (g.mutable) {
          lowerer.unsupported(
            "SC1090",
            rhs,
            `exporting the mutable 'let' binding '${rhs.text}' by reference (Node copies its VALUE at this statement — declare it const, or export a function that reads it)`,
          );
        }
        return { kind: "block", body: [], loc };
      }
      return null;
    }
    // `module.exports = class …{}` — the whole export IS the class
    // (requirers construct their binding: `const C = require('./x');
    // new C()`). The expression collects as a program class right here —
    // its statics queue at this statement, JS's evaluation point — and the
    // statement itself is pure alias plumbing: requirer bindings and
    // in-file `module.exports` references resolve to the class through
    // its symbols (classBySymbol via the export symbol registered below,
    // or the expression's own symbol through propertyAssignedClassInfoOf),
    // so no storage assigns. NamedEvaluation gives these classes name ""
    // (the LHS is a property, not a binding) — Node's answer exactly.
    if (ts.isClassExpression(rhs)) {
      const info = lowerer.lowerClassExpressionInfo(rhs);
      const exportSym = lowerer.checker.getSymbolAtLocation(expr.left);
      if (exportSym && !lowerer.classBySymbol.has(exportSym)) lowerer.classBySymbol.set(exportSym, info);
      return { kind: "block", body: [], loc };
    }
    const g = lowerer.globalsByDeclNode.get(expr);
    if (!g) return null;
    return { kind: "assign", localId: g.id, value: lowerer.lowerExprExpecting(rhs, g.type), loc: locOf(rhs) };
  }
