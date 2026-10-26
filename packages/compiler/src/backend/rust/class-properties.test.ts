import { expect, test } from "vitest";
import { DYN, F64, VOID, type IrModule, type IrRecordShape, type IrType } from "../../ir/ir.js";
import { isSharedRecord, planSharedRecords } from "./shared-records.js";

test("boxed class data keeps reachable record storage shared across its hierarchy", () => {
  const loc = { file: "classes.ts", start: 0, end: 1 };
  const record = (id: string): IrRecordShape => ({ id, fields: [{name: "count", type: F64}], declaredOrder: ["count"] });
  const records = new Map(["child", "extra", "private", "unrelated"].map(id => [id, record(id)]));
  const object: IrType = {kind: "object", className: "Base"};
  const module: IrModule = { irVersion: 13, sourceFile: loc.file, entry: "main", classes: [
    {name: "Base", fields: [{name: "child", type: {kind: "record", shapeId: "child"}}, {name: "%private", type: {kind: "record", shapeId: "private"}}], methods: [], loc},
    {name: "Derived", base: "Base", fields: [{name: "child", type: {kind: "record", shapeId: "child"}}, {name: "extra", type: {kind: "record", shapeId: "extra"}}], methods: [], loc},
  ], functions: [
    {name: "box", params: [{localId: "value", name: "value", type: object}], locals: [], returnType: DYN, body: [{kind: "return", value: {kind: "dynFrom", value: {kind: "varRef", localId: "value", type: object, loc}, type: DYN, loc}, loc}], loc},
    {name: "main", params: [], locals: [], returnType: VOID, body: [], loc},
  ] };
  expect(planSharedRecords(module, records, new Map())).toBe(true);
  expect(isSharedRecord(records.get("child"))).toBe(true);
  expect(isSharedRecord(records.get("extra"))).toBe(true);
  expect(isSharedRecord(records.get("private"))).toBe(false);
  expect(isSharedRecord(records.get("unrelated"))).toBe(false);
});
