import { typeEquals, type IrRecordShape, type IrType, type IrUnionDef } from "./ir.js";
import { nativeRecordShapeSupported } from "./native-record.js";

/** A view neither copies properties nor changes mutable field representations. */
export function recordViewPairs(source: IrType, target: IrType, records: ReadonlyMap<string, IrRecordShape>, unions: Pick<ReadonlyMap<string, IrUnionDef>, "get">): [number, number][] | null {
  const arms = (type: IrType): readonly IrType[] => type.kind === "union" ? unions.get(type.unionId)?.arms ?? [] : [type];
  const targets = arms(target);
  const result: [number, number][] = [];
  for (const [from, type] of arms(source).entries()) {
    const shape = type.kind === "record" ? records.get(type.shapeId) : undefined;
    if (!shape || shape.tuple || shape.indexValue || shape.fields.some(f => f.name === "\0scriptc.call") || !nativeRecordShapeSupported(shape, unions, id => records.get(id))) return null;
    const choices = targets.flatMap((type, to) => {
      const next = type.kind === "record" ? records.get(type.shapeId) : undefined;
      return next && !next.tuple && !next.indexValue && next.fields.every(field => shape.fields.some(old => old.name === field.name && typeEquals(old.type, field.type))) ? [to] : [];
    });
    if (choices.length !== 1) return null;
    result.push([from, choices[0]!]);
  }
  return result.length ? result : null;
}
