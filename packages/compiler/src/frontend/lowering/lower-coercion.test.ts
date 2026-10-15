import { expect, test } from "vitest";
import { BOOL, F64, type IrExpr, type IrType } from "../../ir/ir.js";
import { contextualEmptyArray } from "./lower-coercion.js";

const loc = { file: "empty-array-boundary.ts", start: 0, end: 1 };
const numbers = { kind: "array", elem: F64 } as const;
const rows = { kind: "array", elem: { kind: "record", shapeId: "Row" } } as const;
const literal = (elems: IrExpr[], type: IrType = numbers): IrExpr => ({ kind: "arrayLit", elems, type, loc });
const empty = (): IrExpr => literal([]);
const alias: IrExpr = { kind: "varRef", localId: "existing", type: numbers, loc };
const filled = (): IrExpr => literal([{ kind: "numLit", value: 42, type: F64, loc }]);

test.each([
  ["existing array", alias],
  ["populated array", filled()],
  ["spread operand", { kind: "arrayLit", spreads: [0], elems: [alias], type: numbers, loc }],
  ["conditional with an existing array", { kind: "ternary", cond: { kind: "boolLit", value: true, type: BOOL, loc }, then: empty(), else_: alias, type: numbers, loc }],
  ["conditional with populated values", { kind: "ternary", cond: { kind: "boolLit", value: false, type: BOOL, loc }, then: empty(), else_: filled(), type: numbers, loc }],
] satisfies [string, IrExpr][])("contextual emptiness cannot erase %s", (_name, value) => {
  const before = structuredClone(value);
  expect(contextualEmptyArray(value, rows)).toBeNull();
  expect(value).toEqual(before);
});

test("nested construction cannot retype a captured array or its elements", () => {
  const source = literal([empty(), alias], { kind: "array", elem: numbers });
  const before = structuredClone(source);
  expect(contextualEmptyArray(source, { kind: "array", elem: rows })).toBeNull();
  expect(source).toEqual(before);
});
