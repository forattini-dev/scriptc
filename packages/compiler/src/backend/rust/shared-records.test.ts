import { expect, test } from "vitest";
import type { IrModule, IrRecordShape } from "../../ir/nodes.js";
import { isSharedRecord, planSharedRecords } from "./shared-records.js";

test("Rust storage planning keeps static records typed and leaves shared IR untouched", () => {
  const shapes: IrRecordShape[] = [
    { id: "boundary", fields: [{ name: "count", type: { kind: "f64" } }] },
    { id: "static", fields: [{ name: "label", type: { kind: "string" } }] },
    { id: "nested", fields: [{ name: "items", type: { kind: "array", elem: { kind: "f64" } } }] },
  ];
  const loc = { file: "fixture.ts", start: 0, end: 1 };
  const mod: IrModule = {
    irVersion: 6, sourceFile: loc.file,
    records: shapes,
    entry: "main",
    functions: [{
      name: "main", params: [], locals: [], returnType: { kind: "void" }, loc,
      body: ["boundary", "nested"].map(shapeId => ({
        kind: "exprStmt", loc, expr: {
          kind: "dynFrom", type: { kind: "dyn" }, loc,
          value: { kind: "recordLit", fields: [], type: { kind: "record", shapeId }, loc },
        },
      })),
    }],
  };
  const original = structuredClone(mod);
  const records = new Map(shapes.map(shape => [shape.id, shape]));
  expect(planSharedRecords(mod, records, new Map())).toBe(true);
  expect(isSharedRecord(records.get("boundary"))).toBe(true);
  expect(isSharedRecord(records.get("static"))).toBe(false);
  expect(isSharedRecord(records.get("nested"))).toBe(false);
  expect(mod).toEqual(original);
  expect(shapes.every(shape => !isSharedRecord(shape))).toBe(true);
  // A second emission has its own representation decisions.
  expect(isSharedRecord(new Map(shapes.map(shape => [shape.id, shape])).get("boundary"))).toBe(false);
});
