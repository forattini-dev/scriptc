import { typeEquals, type IrRecordShape, type IrType } from "./ir.js";

/** Dense homogeneous scalar tuples can share the native array representation. */
export function nativeTupleElement(shape: IrRecordShape | undefined): IrType | undefined {
  const first = shape?.fields[0]?.type;
  if (!shape?.tuple || shape.indexValue || !first || !["f64", "bool", "string", "dyn"].includes(first.kind)) return undefined;
  const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
  return fields.every((field, index) => field.name === String(index) && typeEquals(field.type, first)) ? first : undefined;
}
