import type { IrExpr, IrFunction, IrStmt } from "./ir.js";

/** Exactly representable integers, excluding negative zero. These facts
 * justify signed i64 arithmetic as well as unchecked ToUint32 conversion. */
export interface IntegerRange { min: number; max: number }
export type IntegerRanges = ReadonlyMap<IrExpr, IntegerRange | null>;
const SIGNED: IntegerRange = { min: -2147483648, max: 2147483647 };
const UNSIGNED: IntegerRange = { min: 0, max: 4294967295 };

/** Deliberately local range analysis. Facts flow only through straight-line
 * statements and numeric expression evaluation. Unknown expressions and
 * control-flow boundaries discard them; nested bodies start independently.
 * No assumptions about parameters, captures, globals or loop iterations. */
export function analyzeIntegerRanges(fn: IrFunction): IntegerRanges {
  const ranges = new Map<IrExpr, IntegerRange | null>();
  if (fn.async || fn.generator) return ranges;
  const captures = new Set((fn.captures ?? []).map((c) => c.localId));
  const eligible = new Set(fn.locals.filter((l) => l.type.kind === "f64" && !l.boxed && !l.tdz && !captures.has(l.id)).map((l) => l.id));
  type Facts = Map<string, IntegerRange>;

  function remember(e: IrExpr, range: IntegerRange | null): IntegerRange | null {
    // IR normally is a tree, but shared expression objects must be safe at
    // every occurrence. An unknown occurrence invalidates any earlier fact.
    const previous = ranges.get(e);
    ranges.set(e, previous === undefined ? range : previous && range ? {
      min: Math.min(previous.min, range.min), max: Math.max(previous.max, range.max),
    } : null);
    return range;
  }
  function opaque(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(opaque); return; }
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (typeof node["kind"] === "string") ranges.set(value as IrExpr, null);
    for (const [key, child] of Object.entries(node)) if (key !== "type" && key !== "loc") opaque(child);
  }
  function expr(e: IrExpr, facts: Facts): IntegerRange | null {
    let range: IntegerRange | null = null;
    switch (e.kind) {
      case "numLit":
        if (Number.isSafeInteger(e.value) && !Object.is(e.value, -0)) range = { min: e.value, max: e.value };
        break;
      case "varRef": range = facts.get(e.localId) ?? null; break;
      case "bin": {
        // Evaluate in source order: an opaque right operand may invalidate
        // locals, but cannot change the already-snapshotted left value.
        const left = expr(e.left, facts);
        const right = expr(e.right, facts);
        if (e.type.kind !== "f64") break;
        if (e.op === ">>>") range = UNSIGNED;
        else if (["&", "|", "^", "<<", ">>"].includes(e.op)) range = SIGNED;
        else if (left && right && (e.op === "+" || e.op === "-")) {
          const min = e.op === "+" ? left.min + right.min : left.min - right.max;
          const max = e.op === "+" ? left.max + right.max : left.max - right.min;
          if (Number.isSafeInteger(min) && Number.isSafeInteger(max)) range = { min, max };
        }
        break;
      }
      case "unary":
        expr(e.operand, facts);
        if (e.op === "~") range = SIGNED;
        break;
      default:
        facts.clear();
        opaque(e);
        return null;
    }
    return remember(e, range);
  }
  function body(stmts: IrStmt[]): void {
    const facts: Facts = new Map();
    for (const s of stmts) {
      switch (s.kind) {
        case "varDecl": case "assign": {
          const value = s.kind === "varDecl" ? s.init : s.value;
          const range = value ? expr(value, facts) : null;
          facts.delete(s.localId);
          if (range && eligible.has(s.localId)) facts.set(s.localId, range);
          break;
        }
        case "return":
          if (s.value) expr(s.value, facts);
          facts.clear();
          break;
        case "exprStmt": expr(s.expr, facts); break;
        default:
          facts.clear();
          // Only statement-list children are analyzed. Headers, conditions,
          // case selectors and every other expression remain conservative.
          for (const [key, value] of Object.entries(s)) {
            if (key === "loc") continue;
            if (["body", "then", "else_", "tryBody", "catchBody", "finallyBody"].includes(key) && Array.isArray(value)) body(value as IrStmt[]);
            else if (s.kind === "switch" && key === "cases") {
              for (const c of s.cases) { opaque(c.test); body(c.body); }
            } else opaque(value);
          }
      }
    }
  }
  body(fn.body);
  return ranges;
}
