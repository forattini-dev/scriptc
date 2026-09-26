import type { IrExpr, IrModule } from "./ir.js";

export interface ConstantNumericTable {
  symbol: string;
  values: readonly number[];
}

const MAX_TABLE_ELEMENTS = 256;

function literalNumber(expr: IrExpr): number | null {
  if (expr.kind === "numLit") return expr.value;
  if (expr.kind === "unary" && expr.op === "-") {
    const value = literalNumber(expr.operand);
    if (value !== null) return -value;
  }
  return null;
}

/** Find module globals whose only observable uses are primitive indexed
 * reads and length queries. `const` only protects the binding: every other
 * use (including aliases, exports to dynamic code, mutation, and passing or
 * returning the array) disqualifies the table. All functions are inspected,
 * including callbacks, and nested index expressions are checked too.
 *
 * This is read specialization only. Backends retain the original allocation,
 * initialization, receiver evaluation and cleanup. They must guard against
 * an uninitialized receiver and preserve the generic accessor for invalid
 * indices; the constant data must never make a not-yet-initialized array
 * observable early. No IR or runtime representation changes are needed. */
export function findConstantNumericTables(mod: IrModule): ReadonlyMap<string, ConstantNumericTable> {
  const candidates = new Map<string, { values: number[] | null; writes: number; reads: number; rejected: boolean }>();
  for (const global of mod.globals ?? []) {
    if (!global.mutable && global.type.kind === "array" && global.type.elem.kind === "f64") {
      candidates.set(global.id, { values: null, writes: 0, reads: 0, rejected: false });
    }
  }
  if (candidates.size === 0) return new Map();

  function candidateFor(expr: IrExpr) {
    return expr.kind === "varRef" && expr.type.kind === "array" && expr.type.elem.kind === "f64"
      ? candidates.get(expr.localId) : undefined;
  }

  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node["kind"] === "closure") {
      for (const id of (node as IrExpr & { kind: "closure" }).captures) {
        const candidate = candidates.get(id);
        if (candidate) candidate.rejected = true;
      }
    }
    if (node["kind"] === "arrIntrinsic") {
      const read = node as IrExpr & { kind: "arrIntrinsic" };
      const candidate = candidateFor(read.receiver);
      if (candidate && ((read.method === "getNumber" && read.args.length === 1) ||
          (read.method === "length" && read.args.length === 0))) {
        if (read.method === "getNumber") candidate.reads++;
        visit(read.args);
        return;
      }
    }
    if (node["kind"] === "arrayGet" || node["kind"] === "arrayHas" || node["kind"] === "arrayState") {
      const read = node as IrExpr & { kind: "arrayGet" | "arrayHas" | "arrayState" };
      if (candidateFor(read.arr)) { visit(read.index); return; }
    }
    const candidate = typeof node["localId"] === "string" ? candidates.get(node["localId"]) : undefined;
    if (candidate) {
      if (node["kind"] === "assign" && ++candidate.writes === 1) {
        const init = node["value"] as IrExpr;
        if (init.kind === "arrayLit" && !init.spreads?.length && init.elems.length > 0 && init.elems.length <= MAX_TABLE_ELEMENTS) {
          const values = init.elems.map(literalNumber);
          if (values.every((n): n is number => n !== null)) candidate.values = values;
        }
        if (candidate.values === null) candidate.rejected = true;
      } else {
        candidate.rejected = true;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type" && key !== "loc") visit(child);
    }
  }
  visit(mod.functions);
  const tables = new Map<string, ConstantNumericTable>();
  for (const [id, candidate] of candidates) {
    if (!candidate.rejected && candidate.writes === 1 && candidate.reads > 0 && candidate.values !== null) {
      tables.set(id, { symbol: `sc_const_numbers_${tables.size}`, values: candidate.values });
    }
  }
  return tables;
}
