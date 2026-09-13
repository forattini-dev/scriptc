import { nativeTupleElement } from "./native-tuple.js";
import { validRecordDiscriminant } from "./record-discriminant.js";
import type { IrRecordShape, IrType, IrUnionDef } from "./ir.js";

/** Shared native records admit scalars and methods whose arguments/results
 * need no composite copy at the dynamic boundary. Arrays and scalar indexed
 * records have shared views, including optional acyclic nested records.
 * Recursive layouts, record arrays and byte fields remain fenced. */
export function nativeRecordShapeSupported(
  shape: IrRecordShape, unions: Pick<ReadonlyMap<string, IrUnionDef>, "get">,
  getRecord: (id: string) => IrRecordShape | undefined = () => undefined,
  visiting: Set<string> = new Set(),
): boolean {
  if (shape.tuple) return nativeTupleElement(shape) !== undefined;
  if (visiting.has(shape.id)) return false;
  visiting.add(shape.id);
  try {
    const scalar = (type: IrType): boolean => type.kind === "union"
      ? unions.get(type.unionId)?.arms.every(scalar) ?? false
      : ["date", "f64", "bool", "string", "nullT", "undefinedT", "dyn"].includes(type.kind);
    const optionalArray = (type: IrType): boolean => {
      const arms = type.kind === "union" ? unions.get(type.unionId)?.arms : undefined;
      return arms !== undefined && arms.filter(arm => arm.kind === "array").length === 1 &&
        arms.every(arm => arm.kind === "undefinedT" || arm.kind === "nullT" || nativeArrayViewSupported(arm));
    };
    const record = (type: IrType): boolean => {
      const nested = type.kind === "record" ? getRecord(type.shapeId) : undefined;
      return nested !== undefined && nativeRecordShapeSupported(nested, unions, getRecord, visiting);
    };
    const optionalRecord = (type: IrType): boolean => {
      const union = type.kind === "union" ? unions.get(type.unionId) : undefined;
      const arms = union?.arms;
      return arms !== undefined && (arms.filter(arm => arm.kind === "record").length === 1 ||
        (union !== undefined && validRecordDiscriminant(union, getRecord))) &&
        arms.every(arm => arm.kind === "undefinedT" || arm.kind === "nullT" || record(arm));
    };
    const methodValue = (type: IrType): boolean => type.kind === "union"
      ? scalar(type) || optionalArray(type) || optionalRecord(type)
      : record(type) || nativeArrayViewSupported(type) ||
        ["date", "f64", "bool", "string", "dyn"].includes(type.kind);
    const method = (type: IrType): boolean => type.kind === "func" && type.rest !== true &&
      type.params.every(methodValue) && (type.ret.kind === "void" || methodValue(type.ret));
    return !shape.tuple && (shape.indexValue === undefined || shape.indexValue.kind === "dyn" ||
      (shape.fields.length === 0 && (scalar(shape.indexValue) || record(shape.indexValue) || optionalRecord(shape.indexValue)))) &&
      shape.fields.every(field => !field.name.startsWith("%") && (scalar(field.type) || methodValue(field.type) || method(field.type)));
  } finally { visiting.delete(shape.id); }
}

/** A checked extraction retains the map; field access checks its current value. */
export function nativeRecordCheckSupported(
  type: IrType,
  getRecord: (id: string) => IrRecordShape | undefined,
  getUnion: (id: string) => IrUnionDef | undefined,
): boolean {
  if (type.kind === "union") {
    const union = getUnion(type.unionId);
    const arms = union?.arms;
    return arms !== undefined && (arms.filter(arm => arm.kind === "record").length === 1 ||
      (union !== undefined && validRecordDiscriminant(union, getRecord))) &&
      arms.every(arm => arm.kind === "undefinedT" || arm.kind === "nullT" ||
        (arm.kind === "record" && nativeRecordCheckSupported(arm, getRecord, getUnion)));
  }
  const shape = type.kind === "record" ? getRecord(type.shapeId) : undefined;
  return !!shape && nativeRecordShapeSupported(shape, { get: getUnion }, getRecord);
}

/** Native array views can check and box each element without composite copies. */
export function nativeArrayViewSupported(type: IrType): boolean {
  return type.kind === "array" && (nativeArrayViewSupported(type.elem) ||
    ["date", "f64", "bool", "string", "dyn"].includes(type.elem.kind));
}

/** Acyclic dictionaries project scalar or shared record values without copies. */
export function nativeIndexedRecordValue(
  type: IrType, getRecord: (id: string) => IrRecordShape | undefined,
  getUnion: (id: string) => IrUnionDef | undefined,
): IrType | undefined {
  const shape = type.kind === "record" ? getRecord(type.shapeId) : undefined;
  return shape?.fields.length === 0 && shape.indexValue !== undefined &&
    nativeRecordShapeSupported(shape, { get: getUnion }, getRecord)
    ? shape.indexValue : undefined;
}
