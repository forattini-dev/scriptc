import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { mangleLocal } from "../mangle.js";
import { combineIntegerRanges, integerLiteral, mergeIntegerRanges, type IntegerRange } from "./integer-ranges.js";

type NumberValue = { range: IntegerRange; code: string };
type Block = { code: string; result: IntegerRange | null; terminal: boolean };
const name = (id: string): string => `sc_numeric_${mangleLocal(id)}`;

/** A bounded, closed numeric body specialized to proven argument intervals.
 * No memory, globals, captures, mutation, nested calls, loops or exceptions.
 * This is a stack closure invoked immediately, not a heap JS closure. Its
 * parameters keep argument evaluation outside the callee's lexical scope.
 */
export class RustIntegerCallPlan {
  private remaining = 128;
  private readonly localIds: ReadonlySet<string>;
  private constructor(fn: IrFunction) {
    this.localIds = new Set(fn.locals.filter(local => !local.mutable).map(local => local.id));
  }

  static build(fn: IrFunction, args: readonly IntegerRange[]): { range: IntegerRange; cost: number; emit(args: readonly string[]): string } | null {
    if (fn.async || fn.generator || fn.captures !== undefined || fn.syncModuleCacheGlobal ||
      fn.asyncCacheGlobal || fn.asyncCycleCacheGlobal || fn.returnType.kind !== "f64" ||
      fn.params.length !== args.length || args.length > 8 || fn.locals.length > 32 ||
      fn.locals.some(local => local.boxed || local.tdz || local.type.kind !== "f64") ||
      fn.params.some(param => param.type.kind !== "f64")) return null;
    const plan = new RustIntegerCallPlan(fn);
    const scope = new Map<string, IntegerRange>();
    for (const [i, param] of fn.params.entries()) {
      const argument = args[i];
      if (argument === undefined || integerLiteral(argument.min) === null || integerLiteral(argument.max) === null || argument.min > argument.max) return null;
      scope.set(param.localId, argument);
    }
    const block = plan.block(fn.body, scope, 0);
    if (block === null || !block.terminal || block.result === null) return null;
    const params = fn.params.map(param => `${name(param.localId)}: i64`).join(", ");
    return { range: block.result, cost: 128 - plan.remaining,
      emit: values => `(|${params}| -> i64 { ${block.code} })(${values.join(", ")})` };
  }

  private number(expr: IrExpr, scope: ReadonlyMap<string, IntegerRange>, depth: number): NumberValue | null {
    if (--this.remaining < 0 || depth > 16 || expr.type.kind !== "f64") return null;
    if (expr.kind === "numLit") {
      const range = integerLiteral(expr.value);
      return range === null ? null : { range, code: `${expr.value}_i64` };
    }
    if (expr.kind === "varRef") {
      const range = scope.get(expr.localId);
      return range === undefined ? null : { range, code: name(expr.localId) };
    }
    if (expr.kind === "bin") {
      const a = this.number(expr.left, scope, depth + 1), b = this.number(expr.right, scope, depth + 1);
      const range = a && b ? combineIntegerRanges(expr.op, a.range, b.range) : null;
      return a && b && range ? { range, code: `(${a.code} ${expr.op} ${b.code})` } : null;
    }
    if (expr.kind === "libCall" && expr.fn === "math.abs" && expr.args.length === 1 && expr.args[0]) {
      const value = this.number(expr.args[0], scope, depth + 1);
      if (value === null) return null;
      const { min, max } = value.range;
      return { range: { min: min <= 0 && max >= 0 ? 0 : Math.min(Math.abs(min), Math.abs(max)),
        max: Math.max(Math.abs(min), Math.abs(max)) }, code: `(${value.code}).abs()` };
    }
    if (expr.kind === "ternary") {
      const cond = this.boolean(expr.cond, scope, depth + 1);
      const a = this.number(expr.then, scope, depth + 1), b = this.number(expr.else_, scope, depth + 1);
      return cond && a && b ? { range: mergeIntegerRanges(a.range, b.range),
        code: `(if ${cond} { ${a.code} } else { ${b.code} })` } : null;
    }
    return null;
  }

  private boolean(expr: IrExpr, scope: ReadonlyMap<string, IntegerRange>, depth: number): string | null {
    if (--this.remaining < 0 || depth > 16 || expr.type.kind !== "bool") return null;
    if (expr.kind === "boolLit") return String(expr.value);
    if (expr.kind === "bin" && ["<", "<=", ">", ">=", "==", "!="].includes(expr.op)) {
      const a = this.number(expr.left, scope, depth + 1), b = this.number(expr.right, scope, depth + 1);
      return a && b ? `(${a.code} ${expr.op} ${b.code})` : null;
    }
    if (expr.kind === "logical") {
      const a = this.boolean(expr.left, scope, depth + 1), b = this.boolean(expr.right, scope, depth + 1);
      return a && b ? `(${a} ${expr.op} ${b})` : null;
    }
    if (expr.kind === "unary" && expr.op === "!") {
      const value = this.boolean(expr.operand, scope, depth + 1);
      return value === null ? null : `!(${value})`;
    }
    return null;
  }

  private block(statements: readonly IrStmt[], inherited: ReadonlyMap<string, IntegerRange>, depth: number): Block | null {
    if (depth > 16 || statements.length > 32) return null;
    const scope = new Map(inherited), lines: string[] = [];
    let result: IntegerRange | null = null, terminal = false;
    for (const stmt of statements) {
      if (--this.remaining < 0 || terminal) return null;
      if (stmt.kind === "varDecl" && stmt.init !== null && this.localIds.has(stmt.localId) && !scope.has(stmt.localId)) {
        const value = this.number(stmt.init, scope, depth + 1);
        if (value === null) return null;
        scope.set(stmt.localId, value.range);
        lines.push(`let ${name(stmt.localId)}: i64 = ${value.code};`);
      } else if (stmt.kind === "return" && stmt.value !== null) {
        const value = this.number(stmt.value, scope, depth + 1);
        if (value === null) return null;
        result = result === null ? value.range : mergeIntegerRanges(result, value.range);
        terminal = true;
        lines.push(`return ${value.code};`);
      } else if (stmt.kind === "if") {
        const condition = this.boolean(stmt.cond, scope, depth + 1);
        const a = this.block(stmt.then, scope, depth + 1), b = this.block(stmt.else_ ?? [], scope, depth + 1);
        if (condition === null || a === null || b === null) return null;
        for (const branch of [a, b]) if (branch.result !== null) result = result === null ? branch.result : mergeIntegerRanges(result, branch.result);
        terminal = a.terminal && b.terminal;
        lines.push(`if ${condition} { ${a.code} } else { ${b.code} }`);
      } else return null;
    }
    return { code: lines.join(" "), result, terminal };
  }
}
