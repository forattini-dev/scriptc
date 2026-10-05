import * as ts from "../ts7/adapter.js";
import { type IrGlobal, type IrStmt, typeEquals } from "../../ir/ir.js";
import { cjsExportAssignmentOf, isCjsJsFile, locOf } from "../program.js";
import { dynFallbackType, type Lowerer } from "./lowerer.js";

interface ConditionalExport {
  symbol: ts.Symbol;
  global: IrGlobal;
  assignments: Set<ts.BinaryExpression>;
}

const cells = new WeakMap<Lowerer, Map<ts.SourceFile, ConditionalExport>>();

export function conditionalCjsExportSymbol(lowerer: Lowerer, sf: ts.SourceFile): ts.Symbol | null {
  return cells.get(lowerer)?.get(sf)?.symbol ?? null;
}

export function hasConditionalCjsExports(lowerer: Lowerer): boolean { return cells.has(lowerer); }

/** One typed value, chosen during module initialization. Do not treat the
 * checker's export= alias as a compile-time choice: either branch may run,
 * and a block-local function can capture bindings in its own branch. */
export function collectConditionalCjsExport(lowerer: Lowerer, sf: ts.SourceFile, tag: string): void {
  if (!isCjsJsFile(sf) || cells.get(lowerer)?.has(sf)) return;
  const assignments = new Set<ts.BinaryExpression>();
  let nested = false;
  let invalid = false;
  ts.walkPreorder(sf, node => {
    if (!ts.isExpressionStatement(node)) return undefined;
    const exported = cjsExportAssignmentOf(node);
    if (exported === null) return undefined;
    if (exported.kind !== "table" || exported.obj !== null) { invalid = true; return "stop"; }
    // Only synchronous source-file initialization through blocks and ifs.
    // Writes inside callbacks, loops, try/finally, or function bodies keep
    // their existing fences; in particular no post-import live cell leaks.
    for (let parent = node.parent; parent !== sf; parent = parent.parent) {
      if (!ts.isBlock(parent) && !ts.isIfStatement(parent)) { invalid = true; return "stop"; }
      nested = true;
    }
    const moduleName = (exported.expr.left as ts.PropertyAccessExpression).expression;
    const moduleSymbol = lowerer.checker.getSymbolAtLocation(moduleName);
    if (moduleSymbol && lowerer.checker.declarationsOf(moduleSymbol).some(d => !ts.isSourceFile(d) && !d.getSourceFile().isDeclarationFile)) {
      invalid = true; return "stop";
    }
    assignments.add(exported.expr);
    return undefined;
  });
  if (invalid || !nested || assignments.size === 0) return;
  // Every normally completing path must assign: otherwise Node exports its
  // initial object, which cannot be silently replaced by an empty closure.
  const initializes = (stmt: ts.Statement): boolean => {
    if (ts.isExpressionStatement(stmt)) return ts.isBinaryExpression(stmt.expression) && assignments.has(stmt.expression);
    if (ts.isBlock(stmt)) return stmt.statements.some(initializes);
    if (ts.isIfStatement(stmt)) return stmt.elseStatement !== undefined && initializes(stmt.thenStatement) && initializes(stmt.elseStatement);
    return ts.isThrowStatement(stmt);
  };
  if (!sf.statements.some(initializes)) return;
  const symbol = lowerer.checker.getSymbolAtLocation(sf)?.getExports().get("export=" as ts.__String);
  if (!symbol) return;
  let global: IrGlobal | undefined;
  for (const assignment of assignments) {
    const strict = lowerer.typeOf(assignment.right);
    const type = lowerer.mapTypeOf(strict) ?? dynFallbackType(lowerer, assignment.right, strict);
    // Function-only for now. Heterogeneous export values and expando
    // functions require a separate representation, not an ABI guess.
    if (type?.kind !== "func" || (global && !typeEquals(global.type, type))) return;
    global ??= { id: `%g.${tag}%conditionalExport`, name: "exports", type, mutable: true };
  }
  if (!global) return;
  let modules = cells.get(lowerer);
  if (!modules) { modules = new Map(); cells.set(lowerer, modules); }
  modules.set(sf, { symbol, global, assignments });
  lowerer.globalsBySymbol.set(symbol, global);
  for (const assignment of assignments) lowerer.globalsByDeclNode.set(assignment, global);
  lowerer.globalsList.push(global);
}

export function lowerConditionalCjsExport(lowerer: Lowerer, expr: ts.Expression): IrStmt | null {
  const cell = cells.get(lowerer)?.get(expr.getSourceFile());
  if (!cell || !ts.isBinaryExpression(expr) || !cell.assignments.has(expr)) return null;
  return {
    kind: "assign", localId: cell.global.id,
    value: lowerer.lowerExprExpecting(expr.right, cell.global.type), loc: locOf(expr),
  };
}
