import type { IrModule, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { typeKey } from "../../ir/ir.js";

/** Inventory compiled array payloads, including throws inside expression
 * sequences and protected regions. Caught values retain their original ABI;
 * conversion uses the same owning array views as ordinary dynamic boxing. */
export function caughtArrayValues(module: IrModule): { type: IrType; loc: SrcLoc }[] {
  const records = new Map(module.records?.map(record => [record.id, record]));
  const unions = new Map(module.unions?.map(union => [union.id, union]));
  const hasArrayArm = (type: IrType, seen = new Set<string>()): boolean => {
    if (type.kind === "array") return true;
    if (type.kind === "record") return records.get(type.shapeId)?.tuple === true;
    if (type.kind !== "union" || seen.has(type.unionId)) return false;
    seen.add(type.unionId);
    return unions.get(type.unionId)?.arms.some(arm => hasArrayArm(arm, seen)) === true;
  };
  const values = new Map<string, { type: IrType; loc: SrcLoc }>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { kind?: unknown };
    if (node.kind === "throw") {
      const statement = value as Extract<IrStmt, { kind: "throw" }>;
      const type = statement.value.type;
      if (hasArrayArm(type)) {
        values.set(typeKey(type), { type, loc: statement.loc });
      }
    }
    Object.values(value).forEach(visit);
  };
  module.functions.forEach(fn => visit(fn.body));
  return [...values.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value);
}
