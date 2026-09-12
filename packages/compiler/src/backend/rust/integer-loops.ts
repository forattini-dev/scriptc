import type { IrExpr, IrFunction, IrLocal, IrStmt } from "../../ir/ir.js";
import { matchIntegerBytesForLoop } from "../../ir/integer-loops.js";
import { RustIndexRegions } from "./index-regions.js";

/** Backend storage decisions are scoped to the emitted function and loop.
 * Ordinary JS observations still read f64; only proven indices use usize.
 * Async/generator frames and boxed bindings keep their existing storage. */
export class RustIntegerLoops {
  private readonly bindings = new WeakMap<IrFunction, Map<string, string>>();
  readonly regions: RustIndexRegions;

  constructor(private readonly currentFunction: () => IrFunction | null, functions: ReadonlyMap<string, IrFunction> = new Map()) {
    this.regions = new RustIndexRegions(currentFunction, functions);
  }

  match(stmt: Extract<IrStmt, { kind: "for" }>, isBoxed: (local: IrLocal) => boolean) {
    const fn = this.currentFunction();
    if (fn === null || fn.async || fn.generator !== undefined) return null;
    const locals = new Map(fn.locals.map(local => [local.id, local]));
    const loop = matchIntegerBytesForLoop(stmt, locals);
    if (loop === null || loop.limitReceiver.kind !== "varRef") return null;
    const index = locals.get(loop.localId);
    const receiver = locals.get(loop.limitReceiver.localId);
    if (index === undefined || receiver === undefined || isBoxed(index) || isBoxed(receiver)) return null;
    return loop;
  }

  bind(id: string, name: string): void {
    const fn = this.currentFunction();
    if (fn === null) throw new Error("integer loop outside a function");
    let bindings = this.bindings.get(fn);
    if (bindings === undefined) this.bindings.set(fn, bindings = new Map());
    bindings.set(id, name);
  }

  unbind(id: string): void {
    const fn = this.currentFunction();
    if (fn !== null) this.bindings.get(fn)?.delete(id);
  }

  read(id: string): string | undefined {
    const fn = this.currentFunction();
    return this.regions.current()?.read(id) ?? (fn === null ? undefined : this.bindings.get(fn)?.get(id));
  }

  index(expr: IrExpr): string | undefined {
    return this.regions.current()?.index(expr) ?? (expr.kind === "varRef" ? this.read(expr.localId) : undefined);
  }
}
