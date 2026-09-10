import { BOOL, DYN, F64, isUnitType, type IrExpr, type IrStmt, type IrType } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import { lowerAbsenceProbe } from "./lower-exprs.js";
import { lowerNativeRecordDynamicEquality } from "./lower-open-record.js";

function caseEquality(L: Lowerer, disc: IrExpr, node: ts.Expression): IrExpr {
  let value = lowerAbsenceProbe(L, node) ?? L.lowerExpr(node);
  const loc = locOf(node);
  const shared = lowerNativeRecordDynamicEquality(L, disc, value, false);
  if (shared) return shared;
  // A void test still executes before contributing the undefined value.
  if (value.type.kind === "void") value = {
    kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: dynUndefinedExpr(loc), type: DYN, loc,
  };
  const primitive = (type: IrType): boolean => isUnitType(type) ||
    type.kind === "f64" || type.kind === "string" || type.kind === "bool";
  if (isUnitType(value.type) || (value.type.kind === "union" &&
      L.unions.get(value.type.unionId)?.arms.every(primitive))) value = L.coerceToExpected(value, DYN);
  if (!["dyn", "f64", "string", "bool"].includes(value.type.kind)) {
    L.unsupported("SC1090", node, `switch case tests of '${L.fmt(value.type)}' against a checked-dynamic value`);
  }
  return { kind: "dynScalarEq", left: disc, right: value, type: BOOL, loc };
}

/** Awaiting case tests must finish selecting a start clause before entering
 * any body. Keep that selection in ordinary statement IR so every backend
 * can suspend lazily without duplicating bodies or changing fallthrough. */
function selectSuspendingCase(L: Lowerer, statement: Extract<IrStmt, { kind: "switch" }>): IrStmt[] {
  const loc = statement.loc;
  const selected = L.declareHiddenLocal("%switch.selected", F64);
  selected.mutable = true;
  const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const defaultIndex = statement.cases.findIndex(candidate => candidate.test === null);
  let selection: IrStmt[] = [];
  for (const [index, { test }] of [...statement.cases.entries()].reverse()) {
    if (test === null) continue;
    const matched = L.declareHiddenLocal("%switch.matched", BOOL);
    selection = [
      { kind: "varDecl", localId: matched.id, init: test, loc: test.loc },
      { kind: "if", cond: { kind: "varRef", localId: matched.id, type: BOOL, loc: test.loc },
        then: [{ kind: "assign", localId: selected.id, value: number(index), loc }], else_: selection, loc },
    ];
  }
  return [
    { kind: "varDecl", localId: selected.id, init: number(defaultIndex < 0 ? statement.cases.length : defaultIndex), loc },
    ...selection,
    { ...statement, disc: { kind: "varRef", localId: selected.id, type: F64, loc },
      cases: statement.cases.map((candidate, index) => ({ ...candidate, test: number(index) })) },
  ];
}

function containsAwait(node: ts.Node): boolean {
  if (ts.isAwaitExpression(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, child => containsAwait(child) || undefined) === true;
}

/** Reuse the ordinary switch's lazy tests, shared scope, labels and fallthrough.
 * Each case asks whether the saved dynamic discriminant is strictly equal to
 * its source value; switch(true) selects the first successful comparison.
 * No conversion of the discriminant and no duplication of its evaluation. */
export function lowerDynamicSwitch(
  L: Lowerer, statement: ts.SwitchStatement, labels: string[] | undefined, discriminant: IrExpr,
): IrStmt {
  const loc = locOf(statement);
  const local = L.declareHiddenLocal("%switch.dynamic", DYN);
  const disc: IrExpr = { kind: "varRef", localId: local.id, type: DYN, loc: discriminant.loc };
  L.scopes.push(new Map());
  try {
    const cases = statement.caseBlock.clauses.map(clause => ({
      test: ts.isCaseClause(clause) ? caseEquality(L, disc, clause.expression) : null,
      body: L.inCtl("switch", () => L.lowerStmts(clause.statements), labels),
    }));
    const dispatch: Extract<IrStmt, { kind: "switch" }> = {
      kind: "switch", disc: { kind: "boolLit", value: true, type: BOOL, loc }, cases, ...(labels && { labels }), loc,
    };
    const suspendingTests = statement.caseBlock.clauses.some(clause =>
      ts.isCaseClause(clause) && containsAwait(clause.expression));
    return {
      kind: "block", body: [
        { kind: "varDecl", localId: local.id, init: discriminant, loc: discriminant.loc },
        ...(suspendingTests ? selectSuspendingCase(L, dispatch) : [dispatch]),
      ], loc,
    };
  } finally { L.scopes.pop(); }
}
