import { typeEquals, typeKey, type IrRecordShape, type IrType, type IrUnionDef } from "./ir.js";

/** Closed mutable data fields are invariant, including recursive back edges.
 * Distinct container layouts need owning adapters and stay outside this relation. */
export function equivalentRecordType(left: IrType, right: IrType, records: Pick<ReadonlyMap<string, IrRecordShape>, "get">, unions: Pick<ReadonlyMap<string, IrUnionDef>, "get">): boolean {
  const active = new Map<string, number>();
  const closed = (shape: IrRecordShape) => !shape.tuple && !shape.indexValue && !shape.fields.some(f => f.name === "\0scriptc.call");
  const visit = (left: IrType, right: IrType, depth: number): boolean => {
    if (typeEquals(left, right)) return true;
    const key = JSON.stringify([typeKey(left), typeKey(right)]);
    const entered = active.get(key);
    if (entered !== undefined) return depth > entered;
    active.set(key, depth);
    let result = false;
    if (left.kind === "record" && right.kind === "record") {
      const a = records.get(left.shapeId), b = records.get(right.shapeId);
      result = !!a && !!b && closed(a) && closed(b) && a.fields.length === b.fields.length && a.fields.every(field => {
        const other = b.fields.find(f => f.name === field.name);
        return !!other && visit(field.type, other.type, depth + 1);
      });
    } else if (left.kind === "union" && right.kind === "union") {
      const a = unions.get(left.unionId), b = unions.get(right.unionId);
      result = !!a && !!b && a.arms.length > 0 && a.arms.length === b.arms.length &&
        a.arms.every(arm => b.arms.filter(other => visit(arm, other, depth)).length === 1) &&
        b.arms.every(arm => a.arms.filter(other => visit(other, arm, depth)).length === 1);
    }
    active.delete(key);
    return result;
  };
  return visit(left, right, 0);
}
