import { expect, test } from "vitest";
import { DYN, F64, STRING, VOID, funcOf, type IrModule, type IrRecordShape, type IrStmt } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { isSharedRecord, planSharedRecords } from "./shared-records.js";

test.each([false, true])("shared union planning is independent of boundary discovery order: %s", (boundaryFirst) => {
  const loc = { file: "union-view.ts", start: 0, end: 1 };
  const source = { kind: "record", shapeId: "boolean" } as const;
  const shape: IrRecordShape = { id: "boolean", fields: [{ name: "kind", type: STRING }] };
  const value = { kind: "varRef", localId: "%g.source", type: source, loc } as const;
  const wrap: IrStmt = { kind: "exprStmt", loc, expr: {
    kind: "unionWrap", unionId: "flag", tag: 0, value, type: { kind: "union", unionId: "flag" }, loc,
  } };
  const boundary: IrStmt = { kind: "exprStmt", loc, expr: { kind: "dynFrom", value, type: DYN, loc } };
  const mod: IrModule = {
    irVersion: 6, sourceFile: loc.file, entry: "main",
    records: [shape, { id: "value", fields: [{ name: "coerce", type: funcOf([], F64) }, { name: "kind", type: STRING }] },
      { id: "static", fields: [{ name: "count", type: F64 }] }],
    unions: [{ id: "flag", arms: [source, { kind: "record", shapeId: "value" }],
      discriminant: { field: "kind", cases: [{ shapeId: "boolean", values: ["boolean"] }, { shapeId: "value", values: ["value"] }] } }],
    globals: [{ id: "%g.source", name: "source", type: source, mutable: true }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, loc,
      body: boundaryFirst ? [boundary, wrap] : [wrap, boundary] }],
  };
  expect(validateModule(mod)).toEqual([]);
  const before = structuredClone(mod);
  const records = new Map((mod.records ?? []).map(record => [record.id, record]));
  const unions = new Map((mod.unions ?? []).map(union => [union.id, union]));
  expect(planSharedRecords(mod, records, unions)).toBe(true);
  expect(isSharedRecord(records.get("boolean"))).toBe(true);
  expect(isSharedRecord(records.get("value"))).toBe(true);
  expect(isSharedRecord(records.get("static"))).toBe(false);
  expect(mod).toEqual(before);
});

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
  expect(isSharedRecord(records.get("nested"))).toBe(true);
  expect(mod).toEqual(original);
  expect(shapes.every(shape => !isSharedRecord(shape))).toBe(true);
  // A second emission has its own representation decisions.
  expect(isSharedRecord(new Map(shapes.map(shape => [shape.id, shape])).get("boundary"))).toBe(false);
});

test("boundary planning marks nested record storage without mutating input metadata", () => {
  const loc = { file: "fixture.ts", start: 0, end: 1 };
  const shapes: IrRecordShape[] = [
    { id: "leaf", fields: [{ name: "count", type: { kind: "f64" } }] },
    { id: "outer", fields: [{ name: "leaf", type: { kind: "record", shapeId: "leaf" } }] },
  ];
  const mod: IrModule = {
    irVersion: 6, sourceFile: loc.file, records: shapes, entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: { kind: "void" }, loc,
      body: [{ kind: "exprStmt", loc, expr: { kind: "dynFrom", type: { kind: "dyn" }, loc,
        value: { kind: "recordLit", fields: [], type: { kind: "record", shapeId: "outer" }, loc } } }],
    }],
  };
  const records = new Map(shapes.map(shape => [shape.id, shape]));
  expect(planSharedRecords(mod, records, new Map())).toBe(true);
  expect(isSharedRecord(records.get("outer"))).toBe(true);
  expect(isSharedRecord(records.get("leaf"))).toBe(true);
  expect(shapes.every(shape => !isSharedRecord(shape))).toBe(true);
});

test("dictionary boundaries mark composite values while retaining map storage", () => {
  const loc = { file: "dictionary.ts", start: 0, end: 1 };
  const shapes: IrRecordShape[] = [
    { id: "leaf", fields: [{ name: "count", type: { kind: "f64" } }] },
    { id: "map", fields: [], indexValue: { kind: "record", shapeId: "leaf" } },
  ];
  const mod: IrModule = { irVersion: 6, sourceFile: loc.file, records: shapes, entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: { kind: "void" }, loc,
      body: [{ kind: "exprStmt", loc, expr: { kind: "dynCheck", type: { kind: "record", shapeId: "map" }, loc,
        value: { kind: "dynObjLit", fields: [], type: { kind: "dyn" }, loc } } }],
    }],
  };
  const records = new Map(shapes.map(shape => [shape.id, shape]));
  expect(planSharedRecords(mod, records, new Map())).toBe(true);
  expect(isSharedRecord(records.get("leaf"))).toBe(true);
  expect(isSharedRecord(records.get("map"))).toBe(false);
  expect(shapes.every(shape => !isSharedRecord(shape))).toBe(true);
});
