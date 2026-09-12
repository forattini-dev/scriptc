import type { IrExpr, IrFunction, IrLocal, IrStmt } from "../../ir/ir.js";
import { mangleLocal } from "../mangle.js";
import { RustIntegerCallPlan } from "./integer-calls.js";
import { combineIntegerRanges, integerLiteral, mergeIntegerRanges, type IntegerRange as Interval } from "./integer-ranges.js";

type Counted = Extract<IrStmt, { kind: "for" }>;
const MAX_INPUT = 2 ** 26 - 1;
const indexName = (id: string): string => `sc_index_${mangleLocal(id)}`;

// A successful u8 getter yields exactly 0..255. Keep the getter at the
// declaration site: its receiver/index may have effects and it may throw.
function u8Read(expr: IrExpr): boolean {
  return expr.kind === "bytesIntrinsic" && expr.method === "get" && expr.args.length === 1 &&
    expr.type.kind === "f64" && expr.receiver.type.kind === "bytes" && expr.receiver.type.elem === "u8";
}

function visit(value: unknown, callback: (node: Record<string, unknown>) => void, budget = { left: 4096 }, depth = 0): boolean {
  if (--budget.left < 0 || depth > 64) return false;
  if (Array.isArray(value)) return value.every(child => visit(child, callback, budget, depth + 1));
  if (value === null || typeof value !== "object") return true;
  const node = value as Record<string, unknown>;
  callback(node);
  return Object.entries(node).every(([key, child]) => key === "type" || key === "loc" || visit(child, callback, budget, depth + 1));
}

function counter(loop: Counted, locals: ReadonlyMap<string, IrLocal>, writes: ReadonlyMap<string, number>): string | null {
  const init = loop.init, cond = loop.cond, update = loop.update;
  if (init?.kind !== "varDecl" || init.init?.kind !== "numLit" || init.init.value !== 0 || Object.is(init.init.value, -0)) return null;
  const id = init.localId, local = locals.get(id);
  if (!local?.mutable || cond?.kind !== "bin" || cond.op !== "<" || cond.left.kind !== "varRef" || cond.left.localId !== id) return null;
  const increment = update?.kind === "assign" && update.localId === id && update.value.kind === "bin" &&
    update.value.op === "+" && update.value.left.kind === "varRef" && update.value.left.localId === id &&
    update.value.right.kind === "numLit" && update.value.right.value === 1;
  // Exactly the canonical update writes the counter anywhere in this region.
  return increment && writes.get(id) === 1 ? id : null;
}

export class RustIndexRegionPlan {
  readonly external = new Set<string>();
  readonly locals = new Map<string, Interval>();
  readonly loops = new Map<Counted, string>();
  private readonly declared = new Map<string, Extract<IrStmt, { kind: "varDecl" }> | null>();
  private readonly written = new Map<string, number>();
  private readonly bounds = new Map<string, IrExpr>();
  private readonly resolving = new Set<string>();
  private readonly failed = new Set<string>();
  private remaining = 8192;
  private readonly calls = new WeakMap<IrExpr, NonNullable<ReturnType<typeof RustIntegerCallPlan.build>>>();
  private readonly functionLocals: ReadonlyMap<string, IrLocal>;

  private constructor(fn: IrFunction, private readonly isBoxed: (local: IrLocal) => boolean,
    private readonly functions: ReadonlyMap<string, IrFunction>) {
    this.functionLocals = new Map(fn.locals.map(local => [local.id, local]));
  }

  static build(stmt: IrStmt, fn: IrFunction, isBoxed: (local: IrLocal) => boolean,
    functions: ReadonlyMap<string, IrFunction> = new Map()): RustIndexRegionPlan | null {
    if (fn.async || fn.generator !== undefined) return null;
    const plan = new RustIndexRegionPlan(fn, isBoxed, functions);
    const loops: Counted[] = [], indices: IrExpr[] = [], values: IrExpr[] = [];
    let suspended = false;
    if (!visit(stmt, node => {
      if (node.kind === "varDecl") {
        const declaration = node as Extract<IrStmt, { kind: "varDecl" }>;
        plan.declared.set(declaration.localId, plan.declared.has(declaration.localId) ? null : declaration);
      }
      // Iteration elements are bindings too, but their values are not known
      // before the region or fixed across iterations.
      if (node.kind === "forOf" && typeof node.localId === "string") plan.declared.set(node.localId, null);
      if (["assign", "assignExpr", "incDec"].includes(String(node.kind)) && typeof node.localId === "string") {
        plan.written.set(node.localId, (plan.written.get(node.localId) ?? 0) + 1);
      }
      if (["await", "yield", "yieldStar", "closure", "tryCatch", "switch"].includes(String(node.kind))) suspended = true;
      if (node.kind === "for") loops.push(node as Counted);
      if (node.kind === "bytesSet") {
        const store = node as Extract<IrStmt, { kind: "bytesSet" }>;
        indices.push(store.index);
        values.push(store.value);
      }
      if (node.kind === "bytesIntrinsic" && node.method === "get") {
        const index = (node as Extract<IrExpr, { kind: "bytesIntrinsic" }>).args[0];
        if (index !== undefined) indices.push(index);
      }
    }) || suspended) return null;
    for (const loop of loops) {
      const id = counter(loop, plan.functionLocals, plan.written);
      if (id !== null && plan.declared.get(id) != null && loop.cond?.kind === "bin") plan.bounds.set(id, loop.cond.right);
    }
    for (const loop of loops) {
      const id = loop.init?.kind === "varDecl" ? loop.init.localId : null;
      if (id !== null && plan.bounds.has(id) && plan.localRange(id) !== null) plan.loops.set(loop, id);
    }
    for (const id of plan.declared.keys()) plan.localRange(id);
    for (const value of values) plan.range(value);
    const useful = indices.some(index => index.kind !== "numLit" && plan.range(index) !== null);
    return plan.loops.size > 0 && useful && plan.external.size <= 16 && plan.remaining >= 0 ? plan : null;
  }

  private localRange(id: string): Interval | null {
    const known = this.locals.get(id);
    if (known !== undefined) return known;
    const local = this.functionLocals.get(id);
    if (!local || local.type.kind !== "f64" || local.tdz || local.boxed || this.isBoxed(local) || this.failed.has(id) || this.resolving.has(id) || this.resolving.size > 32) return null;
    this.resolving.add(id);
    let result: Interval | null = null;
    const limit = this.bounds.get(id);
    if (limit !== undefined) {
      const bound = this.range(limit);
      if (bound !== null && bound.min >= 0 && bound.max <= MAX_INPUT) result = { min: 0, max: bound.max };
    } else if (!this.written.has(id)) {
      if (this.declared.has(id)) {
        const init = this.declared.get(id)?.init;
        if (!local.mutable && init != null) result = this.range(init);
      } else {
        this.external.add(id);
        result = { min: 0, max: MAX_INPUT };
      }
    }
    this.resolving.delete(id);
    if (result !== null) this.locals.set(id, result);
    else this.failed.add(id);
    return result;
  }

  private range(expr: IrExpr, depth = 0, infer = true): Interval | null {
    if ((infer && --this.remaining < 0) || depth > 32 || expr.type.kind !== "f64") return null;
    if (expr.kind === "numLit") return integerLiteral(expr.value);
    if (expr.kind === "varRef") return infer ? this.localRange(expr.localId) : this.locals.get(expr.localId) ?? null;
    if (u8Read(expr)) return { min: 0, max: 255 };
    if (expr.kind === "ternary") {
      const a = this.range(expr.then, depth + 1, infer), b = this.range(expr.else_, depth + 1, infer);
      return a && b ? mergeIntegerRanges(a, b) : null;
    }
    if (expr.kind === "call") {
      const known = this.calls.get(expr);
      if (known !== undefined) return known.range;
      const fn = this.functions.get(expr.callee);
      if (!infer || fn === undefined) return null;
      const args = expr.args.map(arg => this.range(arg, depth + 1, infer));
      if (args.some(arg => arg === null)) return null;
      const call = RustIntegerCallPlan.build(fn, args as Interval[]);
      this.remaining -= call?.cost ?? 128;
      if (call === null) return null;
      this.calls.set(expr, call);
      return call.range;
    }
    if (expr.kind !== "bin") return null;
    const a = this.range(expr.left, depth + 1, infer), b = this.range(expr.right, depth + 1, infer);
    return a !== null && b !== null ? combineIntegerRanges(expr.op, a, b) : null;
  }

  read(id: string): string | undefined { return this.locals.has(id) ? indexName(id) : undefined; }

  number(expr: IrExpr, emit?: (expr: IrExpr) => string, integerRead?: (expr: IrExpr) => string | null): string | null {
    if (this.range(expr, 0, false) === null) return null;
    if (expr.kind === "numLit") return `${expr.value}_i64`;
    if (expr.kind === "varRef") return indexName(expr.localId);
    if (u8Read(expr)) return emit === undefined ? null : integerRead?.(expr) ?? `(${emit(expr)} as i64)`;
    if (expr.kind === "bin") {
      const a = this.number(expr.left, emit, integerRead), b = this.number(expr.right, emit, integerRead);
      return a !== null && b !== null ? `(${a} ${expr.op} ${b})` : null;
    }
    if (expr.kind === "ternary" && emit !== undefined) {
      const a = this.number(expr.then, emit, integerRead), b = this.number(expr.else_, emit, integerRead);
      return a !== null && b !== null ? `(if ${emit(expr.cond)} { ${a} } else { ${b} })` : null;
    }
    if (expr.kind === "call") {
      const args = expr.args.map(arg => this.number(arg, emit, integerRead));
      return args.every(arg => arg !== null) ? this.calls.get(expr)?.emit(args) ?? null : null;
    }
    return null;
  }

  initializer(expr: IrExpr, emit: (expr: IrExpr) => string, integerRead: (expr: IrExpr) => string | null): string | null {
    // Widen once after the original checked access. All later uses share the
    // immutable integer local; numeric observations are converted back to f64.
    return this.number(expr, emit, integerRead);
  }

  expression(expr: IrExpr): string | null {
    if (expr.kind === "bin" && ["<", "<=", ">", ">=", "==", "!="].includes(expr.op)) {
      const a = this.number(expr.left), b = this.number(expr.right);
      if (a !== null && b !== null) return `(${a} ${expr.op} ${b})`;
    }
    const number = this.number(expr);
    return number === null ? null : `(${number} as f64)`;
  }

  index(expr: IrExpr): string | undefined {
    const number = this.number(expr);
    // Negative and pointer-width-overflow indices must still fail the checked
    // access; an unchecked cast could wrap onto a valid index on 32-bit hosts.
    return number === null ? undefined : `usize::try_from(${number}).unwrap_or(usize::MAX)`;
  }

  guard(): string {
    return [...this.external].map(id => {
      const name = mangleLocal(id);
      return `(${name} >= 0.0 && ${name} <= ${MAX_INPUT}.0 && !${name}.is_sign_negative() && ${name}.fract() == 0.0)`;
    }).join(" && ") || "true";
  }

  declarations(): string[] {
    return [...this.external].map(id => `let ${indexName(id)}: i64 = ${mangleLocal(id)} as i64;`);
  }
}

export class RustIndexRegions {
  private readonly active = new WeakMap<IrFunction, RustIndexRegionPlan>();
  constructor(private readonly currentFunction: () => IrFunction | null,
    private readonly functions: ReadonlyMap<string, IrFunction> = new Map()) {}
  current(): RustIndexRegionPlan | undefined {
    const fn = this.currentFunction();
    return fn === null ? undefined : this.active.get(fn);
  }
  plan(stmt: IrStmt, isBoxed: (local: IrLocal) => boolean): RustIndexRegionPlan | null {
    const fn = this.currentFunction();
    return fn === null || this.active.has(fn) ? null : RustIndexRegionPlan.build(stmt, fn, isBoxed, this.functions);
  }
  bind(plan: RustIndexRegionPlan): () => void {
    const fn = this.currentFunction();
    if (fn === null) throw new Error("index region outside a function");
    const previous = this.active.get(fn);
    this.active.set(fn, plan);
    return () => { if (previous === undefined) this.active.delete(fn); else this.active.set(fn, previous); };
  }
}
