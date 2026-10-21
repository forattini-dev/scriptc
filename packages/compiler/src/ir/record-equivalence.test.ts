import { expect, test } from "vitest";
import type { IrRecordShape, IrType, IrUnionDef } from "./ir.js";
import { equivalentRecordType } from "./record-equivalence.js";
import { recordViewPairs } from "./record-views.js";

const record = (shapeId: string): IrType => ({ kind: "record", shapeId });
const union = (unionId: string): IrType => ({ kind: "union", unionId });
function layouts() {
  const records = new Map<string, IrRecordShape>(["a", "b"].map(id => [id, { id, fields: [
    { name: "next", type: union(id) }, { name: "value", type: { kind: "f64" } },
  ] }]));
  const unions = new Map<string, IrUnionDef>([
    ["a", { id: "a", arms: [record("a"), { kind: "undefinedT" }] }],
    ["b", { id: "b", arms: [{ kind: "undefinedT" }, record("b")] }],
  ]);
  return { records, unions };
}

test("recursive invariant fields compare layouts and union arms rather than IDs", () => {
  const { records, unions } = layouts();
  expect(equivalentRecordType(record("a"), record("b"), records, unions)).toBe(true);
  expect(recordViewPairs(record("a"), record("b"), records, unions)).toEqual([[0, 0]]);
  records.get("b")!.fields[1]!.type = { kind: "string" };
  expect(equivalentRecordType(record("a"), record("b"), records, unions)).toBe(false);
  expect(recordViewPairs(record("a"), record("b"), records, unions)).toBe(null);
});

test("back edges do not admit nested width, tuples or different container storage", () => {
  const { records, unions } = layouts();
  records.get("b")!.fields.push({ name: "extra", type: { kind: "bool" } });
  expect(recordViewPairs(record("b"), record("a"), records, unions)).toBe(null);
  expect(equivalentRecordType({ kind: "array", elem: record("a") }, { kind: "array", elem: record("b") }, records, unions)).toBe(false);
  records.get("b")!.fields.pop();
  records.get("b")!.tuple = true;
  expect(equivalentRecordType(record("a"), record("b"), records, unions)).toBe(false);
});

test("inline cycles, ambiguous arm matches and missing layouts do not prove equality", () => {
  const { records, unions } = layouts();
  unions.get("a")!.arms = [union("a"), { kind: "undefinedT" }];
  unions.get("b")!.arms = [union("b"), { kind: "undefinedT" }];
  expect(equivalentRecordType(union("a"), union("b"), records, unions)).toBe(false);
  unions.get("a")!.arms = [record("a"), record("b")];
  unions.get("b")!.arms = [record("b"), record("a")];
  expect(equivalentRecordType(union("a"), union("b"), records, unions)).toBe(false);
  expect(equivalentRecordType(record("a"), record("missing"), records, unions)).toBe(false);
});

test("nullable views remap unit tags and refuse losing source arms", () => {
  const { records, unions } = layouts();
  unions.set("source", { id: "source", arms: [record("a"), { kind: "nullT" }, { kind: "undefinedT" }] });
  unions.set("target", { id: "target", arms: [{ kind: "undefinedT" }, record("b"), { kind: "nullT" }] });
  expect(recordViewPairs(union("source"), union("target"), records, unions)).toEqual([[0, 1], [1, 2], [2, 0]]);
  expect(recordViewPairs(union("source"), record("b"), records, unions)).toBe(null);
  expect(recordViewPairs(union("missing"), record("b"), records, unions)).toBe(null);
});
