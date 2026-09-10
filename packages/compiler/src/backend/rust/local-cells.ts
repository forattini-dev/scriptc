import type { IrFunction, IrLocal } from "../../ir/nodes.js";
import { mangleLocal } from "../mangle.js";

/** Cells forced by Rust control-flow emission need initialization tracking,
 * but an uncaptured scalar has no heap identity or owning edges. Cell<Option<T>>
 * keeps its state across synchronous catch_unwind closures without allocating.
 * Captures, TDZ, async/generator frames and non-scalars retain the shared cell. */
export class RustLocalCells {
  private readonly storage = new Map<string, "stack" | "heap">();

  constructor(private readonly currentFunction: () => IrFunction | null) {}

  clear(): void { this.storage.clear(); }
  has(id: string): boolean { return this.storage.has(id); }
  isStack(id: string): boolean { return this.storage.get(id) === "stack"; }

  set(id: string, forced: boolean): void {
    if (!forced) { this.storage.delete(id); return; }
    const fn = this.currentFunction();
    const local = fn?.locals.find(local => local.id === id);
    const stack = fn !== null && !fn.async && fn.generator === undefined &&
      local !== undefined && !local.boxed && !local.tdz &&
      (local.type.kind === "f64" || local.type.kind === "bool");
    this.storage.set(id, stack ? "stack" : "heap");
  }

  declaration(local: IrLocal, type: string, value: string | null): string {
    const name = mangleLocal(local.id);
    const mutable = local.mutable ? "mut " : "";
    if (this.isStack(local.id)) {
      const init = value === null ? "None" : `Some(${value})`;
      return `let ${mutable}${name}: std::cell::Cell<Option<${type}>> = std::cell::Cell::new(${init});`;
    }
    const init = value === null ? "runtime::cell_empty()" : `runtime::cell_new(${value})`;
    return `let ${mutable}${name}: runtime::JsCell<${type}> = ${init};`;
  }
}
