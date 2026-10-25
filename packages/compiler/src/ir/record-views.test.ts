import { expect, test } from "vitest";
import type { IrRecordShape, IrType, IrUnionDef } from "./ir.js";
import { recordViewPairs } from "./record-views.js";

const record = (shapeId: string): IrType => ({ kind: "record", shapeId });
const union = (unionId: string): IrType => ({ kind: "union", unionId });
const number: IrType = { kind: "f64" };
const undef: IrType = { kind: "undefinedT" };
function layouts() {
  const records = new Map<string, IrRecordShape>([
    ["base", { id: "base", fields: [{ name: "width", type: number }] }],
    ["view", { id: "view", fields: [{ name: "width", type: number }, { name: "height", type: union("optional") }] }],
  ]);
  const unions = new Map<string, IrUnionDef>([["optional", { id: "optional", arms: [number, undef] }]]);
  return { records, unions };
}
test("optional record views retain source absence and nullable tag mappings", () => {
  const { records, unions } = layouts();
  expect(recordViewPairs(record("base"), record("view"), records, unions)).toEqual([[0, 0]]);
  unions.set("source", { id: "source", arms: [record("base"), undef] });
  unions.set("target", { id: "target", arms: [undef, record("view")] });
  expect(recordViewPairs(union("source"), union("target"), records, unions)).toEqual([[0, 1], [1, 0]]);
});
test("optional views refuse required fields and mutable representation changes", () => {
  const { records, unions } = layouts();
  records.get("view")!.fields[1]!.type = number;
  expect(recordViewPairs(record("base"), record("view"), records, unions)).toBe(null);
  records.get("view")!.fields[1]!.type = union("optional");
  records.get("view")!.fields[0]!.type = union("optional");
  expect(recordViewPairs(record("base"), record("view"), records, unions)).toBe(null);
});
test("optional views retain ambiguity and nominal-storage fences", () => {
  const { records, unions } = layouts();
  records.set("other", { id: "other", fields: [{ name: "width", type: number }, { name: "depth", type: union("optional") }] });
  unions.set("ambiguous", { id: "ambiguous", arms: [record("view"), record("other")] });
  expect(recordViewPairs(record("base"), union("ambiguous"), records, unions)).toBe(null);
  records.get("view")!.fields[1]!.name = "\0scriptc.call";
  expect(recordViewPairs(record("base"), record("view"), records, unions)).toBe(null);
  records.get("view")!.fields[1]!.name = "height";
  records.get("view")!.tuple = true;
  expect(recordViewPairs(record("base"), record("view"), records, unions)).toBe(null);
});
