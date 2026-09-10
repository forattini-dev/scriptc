import { expect, test } from "vitest";
import { validRecordDiscriminant } from "./record-discriminant.js";
import { type IrRecordShape, type IrUnionDef } from "./nodes.js";
const shapes: IrRecordShape[] = ["a", "b"].map(id => ({ id, fields: [{ name: "kind", type: { kind: "string" } }] }));
const get = (id: string) => shapes.find(shape => shape.id === id);
const union = (): IrUnionDef => ({ id: "u", arms: [{ kind: "record", shapeId: "a" }, { kind: "record", shapeId: "b" }],
  discriminant: { field: "kind", cases: [{ shapeId: "a", values: ["a", "alias"] }, { shapeId: "b", values: ["b"] }] } });
test("record discriminants cover every shape with disjoint domains", () => {
  const value = union();
  expect(validRecordDiscriminant(value, get)).toBe(true);
  value.arms.push({ kind: "undefinedT" });
  expect(validRecordDiscriminant(value, get)).toBe(true);
  value.discriminant?.cases[1]?.values.push("alias");
  expect(validRecordDiscriminant(value, get)).toBe(false);
});
test("record discriminants reject missing shapes, fields and empty domains", () => {
  const missing = union(); missing.discriminant?.cases.pop();
  expect(validRecordDiscriminant(missing, get)).toBe(false);
  const empty = union(); empty.discriminant?.cases[0]?.values.splice(0);
  expect(validRecordDiscriminant(empty, get)).toBe(false);
  expect(validRecordDiscriminant(union(), () => undefined)).toBe(false);
  expect(validRecordDiscriminant(union(), id => ({ id, fields: [] }))).toBe(false);
});

test("record discriminant metadata survives serialization and is validated", async () => {
  const { serializeModule, deserializeModule, IR_VERSION } = await import("./serialize.js");
  const { validateModule } = await import("./validate.js");
  const loc = { file: "union.ts", start: 0, end: 1 };
  const mod = { irVersion: IR_VERSION, sourceFile: loc.file, entry: "main", records: shapes,
    unions: [union()], functions: [{ name: "main", params: [], locals: [], returnType: { kind: "void" as const }, body: [], loc }] };
  const decoded = deserializeModule(serializeModule(mod));
  expect(decoded).toEqual(mod);
  expect(validateModule(decoded)).toEqual([]);
  decoded.unions?.[0]?.discriminant?.cases[1]?.values.push("a");
  expect(validateModule(decoded).map(error => error.message)).toContain("union u: invalid record discriminant");
});
