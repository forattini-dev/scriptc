import type * as ts from "./ts7/adapter.js";
import { InternalCompilerError } from "../errors.js";
import { typeKey, type IrType, type IrUnionDef } from "../ir/ir.js";

/** The frontend's union interner — mirrors ShapeRegistry. A union's
 * canonical identity is its typeKey-sorted arm list; two ts unions whose
 * arms map to the same IR types share one unionId (and later one runtime
 * tag numbering: an arm's index in the canonical list IS its tag). Owned by
 * the Lowerer; threaded through mapType exactly like ShapeRegistry. */
export class UnionRegistry {
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, IrUnionDef>();
  /** All interned unions in first-seen (`u0`, `u1`, ...) order. */
  readonly unions: IrUnionDef[] = [];
  /** ts.Types currently being mapped — a back-reference to one is the
   * recursive knot passing through a union (`type Tree = Leaf | Branch`
   * whose Branch arm carries `Tree[]`, the optional field `a?: A` of a
   * mutually recursive pair): mapType answers a NAMED RECURSIVE UNION
   * (recursiveRef) whose arms fill in when the outer frame completes. */
  readonly inProgress = new Set<ts.Type>();
  /** Recursive union ids, keyed by checker type identity — the
   * ShapeRegistry.recIds story exactly (per-declaration identity, byKey
   * folding one-level unfoldings in). */
  private readonly recIds = new Map<ts.Type, string>();
  private readonly pendingRec = new Set<string>();

  /** The union id a back-reference to an in-progress union resolves to:
   * reuses the type's persistent recursive id or mints a PLACEHOLDER
   * entry (empty arms) the outer frame finalizes. */
  recursiveRef(t: ts.Type): string {
    let id = this.recIds.get(t);
    if (id === undefined) {
      id = `u${this.unions.length}`;
      const def: IrUnionDef = { id, arms: [] };
      this.byId.set(id, def);
      this.unions.push(def);
      this.recIds.set(t, id);
      this.pendingRec.add(id);
    }
    return id;
  }

  /** The FINALIZED recursive union for a checker type — undefined while
   * never mapped, mid-construction, or permanently failed. */
  recursiveUnionFor(t: ts.Type): string | undefined {
    const id = this.recIds.get(t);
    return id !== undefined && !this.pendingRec.has(id) ? id : undefined;
  }

  /** True when a back-reference minted a placeholder for `t` that the
   * outer frame has not (yet) finalized. */
  recursivePending(t: ts.Type): boolean {
    const id = this.recIds.get(t);
    return id !== undefined && this.pendingRec.has(id);
  }

  /** Completes a recursive placeholder with its canonical arm list and
   * registers the structural key (first writer wins, like shapes). */
  finalizeRecursive(t: ts.Type, arms: IrType[]): string {
    const id = this.recIds.get(t);
    if (id === undefined) throw new InternalCompilerError("union registry bug: finalizeRecursive without a placeholder");
    if (this.pendingRec.has(id)) {
      const def = this.byId.get(id)!;
      def.arms.push(...arms);
      this.pendingRec.delete(id);
      const key = JSON.stringify(arms.map(typeKey));
      if (!this.byKey.has(key)) this.byKey.set(key, id);
    }
    return id;
  }

  /** Interns a canonical (typeKey-sorted, deduplicated) arm list, returning
   * its unionId. */
  intern(arms: IrType[], discriminant?: IrUnionDef["discriminant"]): string {
    const key = JSON.stringify(arms.map(typeKey)) + (discriminant ? JSON.stringify(discriminant) : "");
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = `u${this.unions.length}`;
      const def: IrUnionDef = { id, arms, ...(discriminant ? { discriminant } : {}) };
      this.byKey.set(key, id);
      this.byId.set(id, def);
      this.unions.push(def);
    }
    return id;
  }

  get(unionId: string): IrUnionDef | undefined {
    return this.byId.get(unionId);
  }
}

