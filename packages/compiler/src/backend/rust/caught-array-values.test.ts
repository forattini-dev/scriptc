import { expect, test } from "vitest";
import type { IrExpr, IrModule, IrStmt } from "../../ir/ir.js";
import { caughtArrayValues } from "./caught-array-values.js";

const loc = { file: "caught.ts", start: 0, end: 1 };
const array: IrExpr = { kind: "arrayLit", elems: [], type: { kind: "array", elem: { kind: "f64" } }, loc };
const thrown: IrStmt = { kind: "throw", value: array, loc };
function fixture(body: IrStmt[]): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [{ name: "main", params: [], locals: [], returnType: { kind: "void" }, body, loc }] };
}

test("collects nested throw sites, deduplicates payload types and leaves the IR intact", () => {
  const mod = fixture([thrown, { kind: "exprStmt", expr: { kind: "seqExpr", stmts: [thrown], result: { kind: "numLit", value: 0, type: { kind: "f64" }, loc }, type: { kind: "f64" }, loc }, loc }]);
  const original = structuredClone(mod);
  expect(caughtArrayValues(mod)).toEqual([{ type: array.type, loc }]);
  expect(mod).toEqual(original);
});

test("ordinary values mentioning arrays are not treated as thrown payloads", () => {
  expect(caughtArrayValues(fixture([{ kind: "exprStmt", expr: array, loc }, { kind: "throw", value: { kind: "strLit", value: "text", type: { kind: "string" }, loc }, loc }]))).toEqual([]);
});

test("retains the union ABI when an array is one of its payload arms", () => {
  const type = { kind: "union", unionId: "u0" } as const;
  const mod = fixture([{ kind: "throw", value: { kind: "varRef", localId: "payload", type, loc }, loc }]);
  mod.unions = [{ id: "u0", arms: [array.type, { kind: "string" }] }];
  expect(caughtArrayValues(mod)).toEqual([{ type, loc }]);
});
