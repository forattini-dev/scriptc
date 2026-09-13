import { expect, test } from "vitest";
import { nativeRecordCheckSupported } from "./native-record.js";
import { BOOL, DYN, F64, STRING, VOID, type IrRecordShape, type IrType } from "./ir.js";

const admitted = (member: IrType): boolean => nativeRecordCheckSupported(
  { kind: "record", shapeId: "api" },
  () => ({ id: "api", fields: [{ name: "run", type: member }] }),
  () => undefined,
);

test.each([F64, STRING, BOOL, DYN, VOID])("shared methods retain supported scalar/dynamic results: %j", ret => {
  expect(admitted({ kind: "func", params: [F64, STRING, BOOL, DYN], ret })).toBe(true);
});

test.each<IrType>([
  { kind: "array", elem: { kind: "record", shapeId: "nested" } },
  { kind: "record", shapeId: "nested" },
  { kind: "bytes", elem: "u32" },
  { kind: "promise", inner: F64 },
])("shared method admission cannot silently copy a composite: %j", composite => {
  expect(admitted(composite)).toBe(false);
  expect(admitted({ kind: "func", params: [composite], ret: F64 })).toBe(false);
  expect(admitted({ kind: "func", params: [], ret: composite })).toBe(false);
});

test("rest methods require a separate adapter contract", () => {
  expect(admitted({ kind: "func", params: [DYN], ret: DYN, rest: true })).toBe(false);
});

test.each<IrType>([{ kind: "bigint" }, { kind: "bytes", elem: "u8" }])("shared fields and methods retain native references: %j", value => {
  expect(admitted(value)).toBe(true);
  expect(admitted({ kind: "func", params: [value], ret: value })).toBe(true);
});


test.each<IrType>([
  { kind: "array", elem: F64 },
  { kind: "array", elem: STRING },
  { kind: "array", elem: BOOL },
  { kind: "array", elem: DYN },
  { kind: "array", elem: { kind: "array", elem: F64 } },
])("shared method array views preserve their source: %j", array => {
  expect(admitted(array)).toBe(true);
  expect(admitted({ kind: "func", params: [array], ret: array })).toBe(true);
});

test("shared methods accept acyclic nested indexed record views", () => {
  const records = new Map([
    ["row", { id: "row", fields: [], indexValue: { kind: "union", unionId: "scalar" } as IrType }],
    ["nested", { id: "nested", fields: [], indexValue: { kind: "record", shapeId: "row" } as IrType }],
  ]);
  const check = (shapeId: string) => nativeRecordCheckSupported(
    { kind: "record", shapeId: "api" },
    id => id === "api" ? { id, fields: [{ name: "push", type: { kind: "func", params: [{ kind: "record", shapeId }], ret: STRING } }] } : records.get(id),
    id => id === "scalar" ? { id, arms: [BOOL, F64, STRING, { kind: "nullT" }] } : undefined,
  );
  expect(check("row")).toBe(true);
  expect(check("nested")).toBe(true);
});

test("shared fields and methods accept a single optional array view", () => {
  const optional: IrType = { kind: "union", unionId: "optional" };
  const check = (field: IrType, arms: IrType[]) => nativeRecordCheckSupported(
    { kind: "record", shapeId: "flag" },
    id => ({ id, fields: [{ name: "member", type: field }] }),
    id => id === "optional" ? { id, arms } : undefined,
  );
  const arms: IrType[] = [{ kind: "array", elem: STRING }, { kind: "undefinedT" }, { kind: "nullT" }];
  expect(check(optional, arms)).toBe(true);
  expect(check({ kind: "func", params: [optional], ret: optional }, arms)).toBe(true);
  expect(check(optional, [{ kind: "array", elem: STRING }, { kind: "array", elem: F64 }])).toBe(false);
  expect(check(optional, [{ kind: "array", elem: { kind: "record", shapeId: "nested" } }, { kind: "undefinedT" }])).toBe(false);
});

test("shared methods box scalar union returns without copying composites", () => {
  const check = (arms: IrType[]) => nativeRecordCheckSupported(
    { kind: "record", shapeId: "flag" },
    id => ({ id, fields: [{ name: "coerce", type: { kind: "func", params: [STRING], ret: { kind: "union", unionId: "result" } } }] }),
    id => id === "result" ? { id, arms } : undefined,
  );
  expect(check([F64, { kind: "undefinedT" }])).toBe(true);
  expect(check([STRING, BOOL, { kind: "nullT" }])).toBe(true);
  expect(check([F64, { kind: "bytes", elem: "u8" }])).toBe(true);
  expect(check([F64, { kind: "bytes", elem: "u32" }])).toBe(false);
});

test("nested shared records admit acyclic and byte views but reject recursive layouts", () => {
  const records = new Map<string, IrRecordShape>([
    ["leaf", { id: "leaf", fields: [{ name: "count", type: F64 }] }],
    ["outer", { id: "outer", fields: [{ name: "leaf", type: { kind: "record", shapeId: "leaf" } }] }],
    ["cycle", { id: "cycle", fields: [{ name: "next", type: { kind: "record", shapeId: "cycle" } }] }],
    ["bytes", { id: "bytes", fields: [{ name: "data", type: { kind: "bytes", elem: "u8" } }] }],
  ]);
  const getRecord = (id: string) => records.get(id);
  const check = (shapeId: string) => nativeRecordCheckSupported({ kind: "record", shapeId }, getRecord, () => undefined);
  expect(check("outer")).toBe(true);
  expect(check("cycle")).toBe(false);
  expect(check("bytes")).toBe(true);
  const optional: IrType = { kind: "union", unionId: "optional" };
  const checkUnion = (arms: IrType[]) => nativeRecordCheckSupported(optional, getRecord, id => ({ id, arms }));
  expect(checkUnion([{ kind: "record", shapeId: "leaf" }, { kind: "undefinedT" }, { kind: "nullT" }])).toBe(true);
  expect(checkUnion([{ kind: "record", shapeId: "leaf" }, { kind: "record", shapeId: "outer" }])).toBe(false);
  expect(checkUnion([{ kind: "record", shapeId: "cycle" }, { kind: "undefinedT" }])).toBe(false);
});

test("indexed record recursion and record arrays retain their admission fences", () => {
  const records = new Map<string, IrRecordShape>([
    ["loop", { id: "loop", fields: [], indexValue: { kind: "record", shapeId: "loop" } }],
    ["leaf", { id: "leaf", fields: [{ name: "kind", type: STRING }] }],
    ["array", { id: "array", fields: [], indexValue: { kind: "array", elem: { kind: "record", shapeId: "leaf" } } }],
  ]);
  for (const shapeId of ["loop", "array"]) expect(nativeRecordCheckSupported(
    { kind: "record", shapeId }, id => records.get(id), () => undefined,
  )).toBe(false);
});
