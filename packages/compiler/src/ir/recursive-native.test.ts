import { expect, test } from "vitest";
import { recursiveNativeReference } from "./recursive-native.js";
import type { IrRecordShape, IrType, IrUnionDef } from "./ir.js";

const record: IrType = { kind: "record", shapeId: "node" };
const union: IrType = { kind: "union", unionId: "json" };

test("recursive views validate all members after following a back edge", () => {
  const shape: IrRecordShape = { id: "node", fields: [
    { name: "children", type: { kind: "array", elem: record } },
    { name: "name", type: { kind: "string" } },
  ] };
  expect(recursiveNativeReference(record, () => shape, () => undefined)).toBe(true);
  shape.fields.push({ name: "missing", type: { kind: "record", shapeId: "missing" } });
  expect(recursiveNativeReference(record, id => id === "node" ? shape : undefined, () => undefined)).toBe(false);
  shape.fields.pop();
  shape.fields.push({ name: "method", type: { kind: "func", params: [], ret: { kind: "void" } } });
  expect(recursiveNativeReference(record, () => shape, () => undefined)).toBe(false);
});

test("recursive JSON views require a complete graph and distinct runtime tags", () => {
  const shape: IrRecordShape = { id: "node", fields: [], indexValue: union };
  const json: IrUnionDef = { id: "json", arms: [
    { kind: "string" }, { kind: "f64" }, { kind: "bool" }, { kind: "nullT" },
    record, { kind: "array", elem: union },
  ] };
  const getRecord = (id: string) => id === "node" ? shape : undefined;
  const getUnion = (id: string) => id === "json" ? json : undefined;
  expect(recursiveNativeReference(union, getRecord, getUnion)).toBe(true);
  json.arms.push({ kind: "record", shapeId: "another" });
  expect(recursiveNativeReference(union, getRecord, getUnion)).toBe(false);
  json.arms.pop();
  json.arms.push({ kind: "array", elem: { kind: "f64" } });
  expect(recursiveNativeReference(union, getRecord, getUnion)).toBe(false);
  json.arms.pop();
  expect(recursiveNativeReference(union, getRecord, () => undefined)).toBe(false);
});

test("inline unions, tuples and acyclic values stay outside recursive admission", () => {
  expect(recursiveNativeReference(union, () => undefined, id => ({ id, arms: [union, { kind: "nullT" }] }))).toBe(false);
  expect(recursiveNativeReference(record, id => ({ id, tuple: true, fields: [{ name: "0", type: record }] }), () => undefined)).toBe(false);
  expect(recursiveNativeReference(record, id => ({ id, fields: [] }), () => undefined)).toBe(false);
});
