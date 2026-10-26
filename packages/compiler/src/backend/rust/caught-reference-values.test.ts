import { expect, test } from "vitest";
import type { IrExpr, IrModule, IrStmt } from "../../ir/ir.js";
import { caughtReferenceValues } from "./caught-reference-values.js";

const loc = { file: "caught.ts", start: 0, end: 1 };
const array: IrExpr = { kind: "arrayLit", elems: [], type: { kind: "array", elem: { kind: "f64" } }, loc };
const thrown: IrStmt = { kind: "throw", value: array, loc };
function fixture(body: IrStmt[]): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [{ name: "main", params: [], locals: [], returnType: { kind: "void" }, body, loc }] };
}

test("collects nested throw sites, deduplicates payload types and leaves the IR intact", () => {
  const mod = fixture([thrown, { kind: "exprStmt", expr: { kind: "seqExpr", stmts: [thrown], result: { kind: "numLit", value: 0, type: { kind: "f64" }, loc }, type: { kind: "f64" }, loc }, loc }]);
  const original = structuredClone(mod);
  expect(caughtReferenceValues(mod)).toEqual([{ type: array.type, loc }]);
  expect(mod).toEqual(original);
});

test("ordinary values mentioning arrays are not treated as thrown payloads", () => {
  expect(caughtReferenceValues(fixture([{ kind: "exprStmt", expr: array, loc }, { kind: "throw", value: { kind: "strLit", value: "text", type: { kind: "string" }, loc }, loc }]))).toEqual([]);
});

test("retains the union ABI when an array is one of its payload arms", () => {
  const type = { kind: "union", unionId: "u0" } as const;
  const mod = fixture([{ kind: "throw", value: { kind: "varRef", localId: "payload", type, loc }, loc }]);
  mod.unions = [{ id: "u0", arms: [array.type, { kind: "string" }] }];
  expect(caughtReferenceValues(mod)).toEqual([{ type, loc }]);
});

test("retains record and ordinary class payload ABIs instead of empty object substitutes", () => {
  const record = { kind: "record", shapeId: "r0" } as const;
  const object = { kind: "object", className: "Packet" } as const;
  const mod = fixture([record, object, record].map((type): IrStmt => ({ kind: "throw", value: { kind: "varRef", localId: "payload", type, loc }, loc })));
  expect(caughtReferenceValues(mod)).toEqual([{ type: object, loc }, { type: record, loc }]);
});

test("keeps a recursive union intact when its reference arm is nested", () => {
  const type = { kind: "union", unionId: "outer" } as const;
  const mod = fixture([{ kind: "throw", value: { kind: "varRef", localId: "payload", type, loc }, loc }]);
  mod.unions = [
    { id: "outer", arms: [{ kind: "union", unionId: "inner" }, { kind: "undefined" }] },
    { id: "inner", arms: [type, { kind: "record", shapeId: "r0" }] },
  ];
  expect(caughtReferenceValues(mod)).toEqual([{ type, loc }]);
});

test("ignores unthrown references and scalar-only recursive unions", () => {
  const type = { kind: "union", unionId: "u0" } as const;
  const mod = fixture([
    { kind: "exprStmt", expr: { kind: "varRef", localId: "packet", type: { kind: "object", className: "Packet" }, loc }, loc },
    { kind: "throw", value: { kind: "varRef", localId: "payload", type, loc }, loc },
  ]);
  mod.unions = [{ id: "u0", arms: [type, { kind: "string" }] }];
  expect(caughtReferenceValues(mod)).toEqual([]);
});
