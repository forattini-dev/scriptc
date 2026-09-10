import type { IrExpr, IrFunction, IrLocal, IrStmt } from "../../ir/nodes.js";
import { rustByteLocalKey, rustByteProjection, type RustByteReadInput } from "./byte-projections.js";
import { rustByteReadInputs } from "./byte-read-regions.js";

/** A freshly allocated local cannot alias anything until it escapes. Admit
 * only length/get/set uses of that local in a synchronous loop, then hold its
 * mutable storage borrow for the region. Other buffers keep ordinary access.
 * This proves isolation, not integer ranges: all slice indices stay checked. */
export class RustByteRegions {
  private readonly active = new WeakMap<IrFunction, Map<string, { name: string; readonly: boolean }>>();
  constructor(private readonly currentFunction: () => IrFunction | null,
    private readonly functions: ReadonlyMap<string, IrFunction>) {}

  inputs(stmt: IrStmt, output: string, isBoxed: (local: IrLocal) => boolean): RustByteReadInput[] {
    const fn = this.currentFunction();
    // An enclosing region may already hold mutable storage for this local.
    // Its emitted slice is the receiver; borrowing the Gc again would panic.
    return fn === null ? [] : rustByteReadInputs(stmt, output, fn, this.functions, isBoxed)
      .filter(input => !this.active.get(fn)?.has(input.key));
  }

  fresh(stmt: IrStmt, isBoxed: (local: IrLocal) => boolean): string | null {
    const fn = this.currentFunction();
    if (fn === null || fn.async || fn.generator !== undefined || stmt.kind !== "varDecl" ||
      stmt.init?.kind !== "bytesNew" || stmt.init.source?.type.kind !== "f64") return null;
    const local = fn.locals.find(local => local.id === stmt.localId);
    return local?.type.kind === "bytes" && local.type.elem === "u8" && !local.mutable &&
      !local.tdz && !isBoxed(local) ? local.id : null;
  }

  canBorrow(stmt: IrStmt, id: string): boolean {
    let writes = 0;
    const receiver = (value: unknown): boolean => value !== null && typeof value === "object" &&
      "kind" in value && value.kind === "varRef" && "localId" in value && value.localId === id;
    function walk(value: unknown): boolean {
      if (Array.isArray(value)) return value.every(walk);
      if (value === null || typeof value !== "object") return true;
      const node = value as Record<string, unknown>;
      // try emission synthesizes Completion::Return dispatch even without an IR return.
      if (node.kind === "tryCatch" || node.kind === "return" || node.kind === "await" || node.kind === "yield" || node.kind === "yieldStar") return false;
      if ((node.kind === "break" || node.kind === "continue") && node.label !== undefined) return false;
      if (node.kind === "bytesIntrinsic" && receiver(node.receiver)) {
        if (node.method !== "get" && node.method !== "length" && node.method !== "byteLength") return false;
        return walk(node.args);
      }
      if (node.kind === "bytesSet" && receiver(node.arr)) {
        writes++;
        return walk(node.index) && walk(node.value);
      }
      // A bare reference could escape via a call, alias, return or capture;
      // writes to the binding also invalidate the original receiver proof.
      if (node.localId === id || (Array.isArray(node.captures) && node.captures.includes(id))) return false;
      return Object.entries(node).every(([key, child]) => key === "type" || key === "loc" || walk(child));
    }
    return walk(stmt) && writes > 0;
  }

  bind(id: string, name: string, readonly = false): () => void {
    return this.bindInput({ key: rustByteLocalKey(id), localId: id }, name, readonly);
  }

  bindInput(input: RustByteReadInput, name: string, readonly = true): () => void {
    const id = input.key;
    const fn = this.currentFunction();
    if (fn === null) throw new Error("byte region outside a function");
    let bindings = this.active.get(fn);
    if (!bindings) this.active.set(fn, bindings = new Map());
    const previous = bindings.get(id);
    bindings.set(id, { name, readonly });
    return () => { if (previous === undefined) bindings.delete(id); else bindings.set(id, previous); };
  }

  read(expr: IrExpr, readonly = false): string | null {
    const fn = this.currentFunction();
    const input = rustByteProjection(expr, this.functions);
    const binding = fn !== null && input !== null ? this.active.get(fn)?.get(input.key) : undefined;
    return binding?.readonly === readonly ? binding.name : null;
  }
}
