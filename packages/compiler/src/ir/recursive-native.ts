import { typeKey, type IrRecordShape, type IrType, type IrUnionDef } from "./ir.js";

/** Recursive structural values have live record/map/array views. Inline union
 * cycles and ambiguous object/array tags still need a different contract. */
export function recursiveNativeReference(
  type: IrType, getRecord: (id: string) => IrRecordShape | undefined,
  getUnion: (id: string) => IrUnionDef | undefined,
): boolean {
  const active = new Map<string, number>();
  const complete = new Set<string>();
  let recursive = false;
  const visit = (type: IrType, heapEdges: number): boolean => {
    const key = typeKey(type);
    const depth = active.get(key);
    if (depth !== undefined) { recursive = true; return heapEdges > depth; }
    if (complete.has(key)) return true;
    active.set(key, heapEdges);
    let valid: boolean;
    switch (type.kind) {
      case "record": {
        const shape = getRecord(type.shapeId);
        valid = shape !== undefined && shape.id === type.shapeId && !shape.tuple &&
          (shape.indexValue === undefined || shape.fields.length === 0) &&
          shape.fields.every(field => !field.name.startsWith("%") && visit(field.type, heapEdges + 1)) &&
          (shape.indexValue === undefined || visit(shape.indexValue, heapEdges + 1));
        break;
      }
      case "array": valid = visit(type.elem, heapEdges + 1); break;
      // A method returning its owning record closes a guarded reference
      // cycle, just like an array element does. Keep other callable graphs
      // outside this contract: rest/adapted parameters need their own ABI.
      case "func": valid = type.rest !== true && type.ret.kind === "record" &&
        type.params.every(param => ["f64", "bool", "string", "dyn"].includes(param.kind)) &&
        visit(type.ret, heapEdges); break;
      case "union": {
        const union = getUnion(type.unionId);
        const tags = new Set<string>();
        valid = union !== undefined && union.id === type.unionId && union.arms.length >= 2 && union.arms.every(arm => {
          if (!["record", "array", "f64", "bool", "string", "nullT", "undefinedT"].includes(arm.kind) || tags.has(arm.kind)) return false;
          tags.add(arm.kind);
          return visit(arm, heapEdges);
        });
        break;
      }
      default: valid = ["f64", "bool", "string", "nullT", "undefinedT", "dyn"].includes(type.kind);
    }
    active.delete(key);
    if (valid) complete.add(key);
    return valid;
  };
  return visit(type, 0) && recursive;
}
