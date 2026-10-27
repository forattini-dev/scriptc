import type { IrModule, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { typeKey } from "../../ir/ir.js";

/** Inventory compiled reference and BigInt-union payloads at actual throw sites, including
 * expression sequences and protected regions. Preserve the full payload ABI;
 * conversion reuses owning array/record views and class identity mirrors. */
export function caughtReferenceValues(module: IrModule): { type: IrType; loc: SrcLoc }[] {
  const unions = new Map(module.unions?.map(union => [union.id, union]));
  const hasOwnedArm = (type: IrType, seen = new Set<string>()): boolean => {
    if (type.kind === "array" || type.kind === "record" || type.kind === "object" || type.kind === "bigint") return true;
    if (type.kind !== "union" || seen.has(type.unionId)) return false;
    seen.add(type.unionId);
    return unions.get(type.unionId)?.arms.some(arm => hasOwnedArm(arm, seen)) === true;
  };
  const values = new Map<string, { type: IrType; loc: SrcLoc }>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { kind?: unknown };
    if (node.kind === "throw") {
      const statement = value as Extract<IrStmt, { kind: "throw" }>;
      const type = statement.value.type;
      // Direct BigInts have a primitive bridge. A union needs its complete
      // compiled ABI so the active Number/BigInt arm survives the catch.
      if (type.kind !== "bigint" && hasOwnedArm(type)) {
        values.set(typeKey(type), { type, loc: statement.loc });
      }
    }
    Object.values(value).forEach(visit);
  };
  module.functions.forEach(fn => visit(fn.body));
  return [...values.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value);
}
