import { DYN, typeEquals, type IrRecordShape, type IrType } from "./ir.js";

/** Dense scalar/callback tuples retain one owning native array. A mixed
 * tuple uses tagged slots; a homogeneous scalar tuple keeps its typed view. */
export function nativeTupleElement(shape: IrRecordShape | undefined): IrType | undefined {
  const first = shape?.fields[0]?.type;
  if (!shape?.tuple || shape.indexValue || !first) return undefined;
  const scalar = (type: IrType): boolean => ["f64", "bool", "string", "dyn"].includes(type.kind);
  const slot = (type: IrType): boolean => scalar(type) || (type.kind === "func" && type.rest !== true &&
    type.params.every(scalar) && (type.ret.kind === "void" || scalar(type.ret)));
  const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
  if (!fields.every((field, index) => field.name === String(index) && slot(field.type))) return undefined;
  return scalar(first) && fields.every(field => typeEquals(field.type, first)) ? first : DYN;
}
