/* The lowering's LEXICAL ENVIRONMENT: the stack of function contexts (FnCtx, innermost last), each holding its block
 * scopes, and the resolution that turns identifiers and `this` into locals. A binding found in an ENCLOSING function
 * becomes a capture: the origin binding is boxed and a capture entry is threaded through every function in between.
 *
 * Frames open only through callbacks (inFunction, inScope, withThis, inOwnerEnvironment), which always restore the
 * stacks, so an early return or a throw can never leave a scope open. The environment knows nothing about statement
 * lowering or the runtime-optional analysis: the Lowerer supplies those through ScopeEnvHooks. */
import * as ts from "../ts7/adapter.js";
import type { IrLocal, IrParam, IrStmt, IrType } from "../../ir/ir.js";
import { InternalCompilerError } from "../../errors.js";

/** Sentinel binding key for `this` (which has no ts.Symbol): a stable
 * object identity used in the same scope/capture maps as real symbols, so
 * arrows capturing `this` ride the ordinary capture machinery. */
const THIS_BINDING = { escapedName: "%this" } as unknown as ts.Symbol;

/** One block scope: the bindings it declares, by symbol. */
export type Scope = Map<ts.Symbol, IrLocal>;

/** Per-function lowering context. A stack of these models nested functions:
 * identifier resolution walks outward, and a hit in an enclosing context
 * turns into a capture (boxing the binding at its origin and threading it
 * through every function in between). */
export interface FnCtx {
  locals: IrLocal[];
  scopes: Scope[];
  localCounters: Map<string, number>;
  /** Lifted functions only: capture entries (also present in `locals`,
   * boxed), in closure caps[] order. undefined ⇔ plain declared function. */
  captures: IrParam[] | null;
  /** Parent-function localIds feeding each capture, parallel to captures. */
  captureSources: string[];
  captureBySymbol: Map<ts.Symbol, IrLocal>;
  /** Named function expressions/declarations: the function's own name
   * symbol. Self-references become `selfRef` (NOT a capture — a box holding
   * its own closure would be an RC cycle and leak). */
  selfSymbol: ts.Symbol | null;
  selfType: IrType | null;
  /** Await is legal here (async function body). */
  isAsync?: boolean;
  /** Yield is legal here (generator function body): the yield/next value
   * channels the yield lowering types itself against. */
  generator?: { yieldT: IrType; nextT: IrType; resultType?: IrType & { kind: "record" } } | null;
  /** VARIADIC `arguments` form (rest-marked func type with no declared
   * rest param): the synthetic trailing dyn-array param `arguments`
   * reads resolve to. */
  argumentsLocal?: IrLocal | null;
  /** Declared return type — lets `return` detect record-shape mismatches
   * (SC2002) before the validator would ICE on them. */
  returnType: IrType;
  /** Implicit-any instance RETURN INFERENCE (resolveInferredReturn):
   * present ⇔ `return` statements lower their values BARE (no coercion)
   * and record themselves here; the post-pass unifies the types and wraps
   * each return onto the settled one. `returnType` holds the DYN pin. */
  inferReturn?: { entries: { stmt: IrStmt; node: ts.Expression | null }[] } | null;
  /** Enclosing jump targets, innermost last. `labels` carries the source
   * statement's JS label names so labeled break/continue resolve. Finally
   * regions do not appear here: the backends route every abrupt completion
   * through the cleanup regions it crosses. Per function, so a nested
   * function's jumps never bind to enclosing constructs. */
  ctl: { kind: "loop" | "switch" | "block"; labels?: string[] }[];
}

export function newFnCtx(
  lifted: boolean,
  selfSymbol: ts.Symbol | null,
  selfType: IrType | null,
  returnType: IrType,
): FnCtx {
  return {
    locals: [],
    scopes: [new Map()],
    localCounters: new Map(),
    captures: lifted ? [] : null,
    captureSources: [],
    captureBySymbol: new Map(),
    selfSymbol,
    selfType,
    returnType,
    ctl: [],
  };
}

/** What resolution needs from the rest of the lowering. */
export interface ScopeEnvHooks {
  /** A symbol bound nowhere on the stack, met at a reference: JS hoisting (a forward-captured const, a nested function
   * declaration, a `var`) may declare it where it belongs. Answer true when it did, and the lookup runs again. */
  predeclare(symbol: ts.Symbol): boolean;
  /** A capture entry was threaded into a nested function from `parent` (the origin binding or the enclosing entry). */
  captureThreaded(parent: IrLocal, entry: IrLocal): void;
  /** A binding that cannot be captured: report it. Throws. */
  refuse(symbol: ts.Symbol, blame: ts.Node | undefined, message: string): never;
}

export class ScopeEnv {
  private readonly stack: FnCtx[] = [];

  constructor(private readonly hooks: ScopeEnvHooks) {}

  /** The open function contexts, outermost first. */
  get frames(): readonly FnCtx[] {
    return this.stack;
  }

  /** The innermost open function context. */
  get current(): FnCtx {
    const top = this.stack[this.stack.length - 1];
    if (!top) throw new InternalCompilerError("lowerer bug: no active function context");
    return top;
  }

  /** The current function's innermost block scope: where declarations register. */
  get innermostScope(): Scope {
    const scopes = this.current.scopes;
    return scopes[scopes.length - 1]!;
  }

  /** Runs `body` inside the function context `ctx`. */
  inFunction<T>(ctx: FnCtx, body: () => T): T {
    this.stack.push(ctx);
    try {
      return body();
    } finally {
      this.stack.pop();
    }
  }

  /** Runs `body` in a fresh block scope of the current function, opened with `bindings` already in place. */
  inScope<T>(body: () => T, bindings?: Iterable<readonly [ts.Symbol, IrLocal]>): T {
    const scopes = this.current.scopes;
    scopes.push(new Map(bindings));
    try {
      return body();
    } finally {
      scopes.pop();
    }
  }

  /** Runs `body` with `this` bound to `local`: arrows and nested lowering inside it read that binding. */
  withThis<T>(local: IrLocal, body: () => T): T {
    return this.inScope(body, [[THIS_BINDING, local]]);
  }

  /** Whether `ctx` is open and `frame` is one of its open scopes. */
  isOpen(ctx: FnCtx, frame: Scope): boolean {
    return this.stack.includes(ctx) && ctx.scopes.includes(frame);
  }

  /** Runs `body` in an ENCLOSING function's environment as it stood at `frame`: the function stack truncates to `ctx`
   * and its scopes to `frame`, then both restore. JS hoisting lowers a later declaration at an earlier reference this
   * way, so the declaration binds in its own scope and its captures thread from its own parents. */
  inOwnerEnvironment<T>(ctx: FnCtx, frame: Scope, body: () => T): T {
    const depth = this.stack.indexOf(ctx);
    const frameIndex = ctx.scopes.indexOf(frame);
    if (depth < 0 || frameIndex < 0) throw new InternalCompilerError("lowerer bug: the owner environment is not open");
    const functionTail = this.stack.splice(depth + 1);
    const scopeTail = ctx.scopes.splice(frameIndex + 1);
    try {
      return body();
    } finally {
      ctx.scopes.push(...scopeTail);
      this.stack.push(...functionTail);
    }
  }

  /** A local of the current function, bound to `symbol` in the innermost scope (bound to nothing without a symbol). */
  declare(symbol: ts.Symbol | undefined, name: string, type: IrType, mutable: boolean): IrLocal {
    const local = this.freshLocal(this.current, name, type, mutable);
    if (symbol) this.innermostScope.set(symbol, local);
    return local;
  }

  /** A function-scope local bound to NO symbol: a hidden ABI slot or a lowering temporary nothing in the source names. */
  declareHidden(name: string, type: IrType): IrLocal {
    return this.freshLocal(this.current, name, type, false);
  }

  /** Declares the current method's `this` parameter local. */
  declareThis(type: IrType): IrLocal {
    const local: IrLocal = { id: "this.0", name: "this", type, mutable: false };
    this.current.locals.push(local);
    this.innermostScope.set(THIS_BINDING, local);
    return local;
  }

  /** The binding for `symbol` inside context `ctx` — a scoped local or an
   * already-threaded capture entry. */
  bindingIn(ctx: FnCtx, symbol: ts.Symbol): IrLocal | null {
    for (let i = ctx.scopes.length - 1; i >= 0; i--) {
      const local = ctx.scopes[i]!.get(symbol);
      if (local) return local;
    }
    return ctx.captureBySymbol.get(symbol) ?? null;
  }

  /** The nearest binding of `symbol` on the whole stack, READ-ONLY: no boxing, threading or predeclaring. A
   * speculative query (isIslandExpr) through a context that takes no captures must not mutate capture state — the
   * real lowering path still resolves (and diagnoses) the reference itself. */
  peek(symbol: ts.Symbol): IrLocal | null {
    for (let depth = this.stack.length - 1; depth >= 0; depth--) {
      const hit = this.bindingIn(this.stack[depth]!, symbol);
      if (hit) return hit;
    }
    return null;
  }

  /** The binding of `symbol` in an ENCLOSING function (never the current one), read-only. */
  originOf(symbol: ts.Symbol): IrLocal | null {
    for (let depth = this.stack.length - 2; depth >= 0; depth--) {
      const hit = this.bindingIn(this.stack[depth]!, symbol);
      if (hit) return hit;
    }
    return null;
  }

  /** Lexical `this` — the enclosing method's this-param, possibly captured
   * through arrows (function expressions/declarations reset `this` in JS;
   * their bodies never see an enclosing method's binding). */
  resolveThis(): IrLocal | null {
    return this.resolve(THIS_BINDING);
  }

  /** Resolves `symbol` to a local of the CURRENT function, creating capture entries (and boxing the origin binding)
   * when it lives in an enclosing function. `blame` is the referencing node: only references may predeclare. */
  resolve(symbol: ts.Symbol, blame?: ts.Node): IrLocal | null {
    const direct = this.bindingIn(this.current, symbol);
    if (direct) return direct;

    // Search enclosing functions, innermost first.
    for (let depth = this.stack.length - 2; depth >= 0; depth--) {
      const origin = this.bindingIn(this.stack[depth]!, symbol);
      if (!origin) continue;
      // dyn captures ride an UNTRACED obj-box (scr_dyn_retain_v/release_v
      // — boxNewC): the mustCall wrapper closing over its implicit-any
      // `fn` param. A dyn tree is pure data except the function kind,
      // whose closure edge the collector never sees — cycles through a
      // captured dyn are uncollectable (leak, never dangle: trial
      // deletion treats untraced edges as external roots). SEMANTICS.md.
      // jsval captures are fine: the box is an obj-box carrying the
      // island handle's own retain/release (scr_jsval_*_v), untraced like
      // every jsval container position — engine-side back-references are
      // the island's documented collection stance, not the box's.
      if (origin.type.kind === "caught") {
        // A catch binding never escapes its catch (KEEP NARROW): narrow it
        // into a typed local and capture THAT.
        this.hooks.refuse(symbol, blame, "closures capturing catch bindings (narrow into a typed local first)");
      }
      // The binding escapes into a nested function: it must live in a box,
      // shared by everyone (that's what makes mutation visible everywhere).
      origin.boxed = true;
      // Thread a capture through every function between origin and here.
      let parentEntry = origin;
      for (let j = depth + 1; j < this.stack.length; j++) {
        const ctx = this.stack[j]!;
        let entry = ctx.captureBySymbol.get(symbol);
        if (!entry) {
          // A context that takes NO captures (a plain declared function —
          // monomorphized/implicit instances lower this way) cannot carry
          // the binding through: the shape is a module binding whose only
          // storage is the init function's LOCAL (a typed-but-unmappable
          // const — the file-scope `new Map()` ledger idiom) read from
          // inside a nested instance. Fence it — in JS the statement
          // defers to its runtime trap like every collection failure;
          // asserting here was an ICE on ordinary npm-static JS.
          if (ctx.captures === null) {
            this.hooks.refuse(
              symbol,
              blame,
              `the binding '${origin.name}' captured through a plain nested function (the declaration has no static storage a capture can thread — bind the value through a typed const, or read it in the declaring scope)`,
            );
          }
          const count = ctx.localCounters.get(origin.name) ?? 0;
          ctx.localCounters.set(origin.name, count + 1);
          entry = {
            id: `${origin.name}.${count}`,
            name: origin.name,
            type: origin.type,
            mutable: origin.mutable,
            boxed: true,
            // TDZ travels with the binding: reads through ANY capture of a
            // forward-captured const must trap while the box is empty.
            ...(origin.tdz ? { tdz: true as const } : {}),
          };
          ctx.locals.push(entry);
          ctx.captureBySymbol.set(symbol, entry);
          ctx.captures.push({ localId: entry.id, name: entry.name, type: entry.type });
          ctx.captureSources.push(parentEntry.id);
          this.hooks.captureThreaded(parentEntry, entry);
        }
        parentEntry = entry;
      }
      return parentEntry;
    }
    // Nothing declared yet anywhere on the stack: JS hoisting may still bind it (a function declared BEFORE a const it
    // captures, a nested `function f() {}` referenced above its declaration, a `var` read before its statement).
    // Predeclare it at its scope's entry and resolve again: the recursion finds it and threads captures normally.
    if (blame && this.hooks.predeclare(symbol)) {
      return this.resolve(symbol, blame);
    }
    return null;
  }

  private freshLocal(ctx: FnCtx, name: string, type: IrType, mutable: boolean): IrLocal {
    const count = ctx.localCounters.get(name) ?? 0;
    ctx.localCounters.set(name, count + 1);
    const local: IrLocal = { id: `${name}.${count}`, name, type, mutable };
    ctx.locals.push(local);
    return local;
  }
}
