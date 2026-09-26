import { expect, test } from "vitest";
import { analyzeIntegerRanges } from "./integer-ranges.js";
import { F64, type IrExpr, type IrFunction, type IrStmt } from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId = "x"): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const bin = (op: Extract<IrExpr, { kind: "bin" }>["op"], left: IrExpr, right: IrExpr): IrExpr => ({ loc, kind: "bin", op, left, right, type: F64 });
const assign = (value: IrExpr): IrStmt => ({ loc, kind: "assign", localId: "x", value });
const fn = (body: IrStmt[], boxed = false): IrFunction => ({ loc, name: "f", params: [], returnType: F64, locals: [{ id: "x", name: "x", type: F64, mutable: true, ...(boxed ? { boxed: true as const } : {}) }], body });

test("tracks exact additions and bitwise conversions through assignments", () => {
  const sum = bin("+", ref(), bin("<<", ref(), num(3)));
  const unsigned = bin(">>>", ref(), num(0));
  const ranges = analyzeIntegerRanges(fn([assign(bin("|", num(0), num(0))), assign(sum), { loc, kind: "return", value: unsigned }]));
  expect(ranges.get(sum)).toEqual({ min: -4294967296, max: 4294967294 });
  expect(ranges.get(unsigned)).toEqual({ min: 0, max: 4294967295 });
});

test("rejects negative zero, fractions, nonfinite values and imprecise sums", () => {
  for (const value of [-0, 0.5, NaN, Infinity, -Infinity, 9007199254740992]) {
    const sum = bin("+", num(value), num(0));
    expect(analyzeIntegerRanges(fn([{ loc, kind: "return", value: sum }])).get(sum)).toBeNull();
  }
  const exact = bin("-", num(Number.MAX_SAFE_INTEGER), num(1));
  const rounded = bin("+", num(Number.MAX_SAFE_INTEGER), num(2));
  const ranges = analyzeIntegerRanges(fn([assign(exact), { loc, kind: "return", value: rounded }]));
  expect(ranges.get(exact)).toEqual({ min: 9007199254740990, max: 9007199254740990 });
  expect(ranges.get(rounded)).toBeNull();
});

test("forgets facts across opaque expressions, control flow and boxed locals", () => {
  const sum = (): IrExpr => bin("+", ref(), num(1));
  const call: IrExpr = { loc, kind: "call", callee: "unknown", args: [], type: F64 };
  const afterCall = sum();
  const afterBlock = sum();
  const boxed = sum();
  const ranges = analyzeIntegerRanges(fn([
    assign(num(1)), { loc, kind: "exprStmt", expr: call }, assign(afterCall),
    assign(num(1)), { loc, kind: "block", body: [assign(num(Infinity))] }, { loc, kind: "return", value: afterBlock },
  ]));
  expect(ranges.get(afterCall)).toBeNull();
  expect(ranges.get(afterBlock)).toBeNull();
  expect(analyzeIntegerRanges(fn([assign(num(1)), { loc, kind: "return", value: boxed }], true)).get(boxed)).toBeNull();
});

test("analyzes nested bodies independently and snapshots operands before writes", () => {
  const before = ref();
  const write: IrExpr = { loc, kind: "assignExpr", localId: "x", value: num(Infinity), type: F64 };
  const after = ref();
  const nested = bin("+", ref(), num(1));
  const ranges = analyzeIntegerRanges(fn([
    assign(num(1)), { loc, kind: "exprStmt", expr: bin("|", before, write) }, { loc, kind: "exprStmt", expr: after },
    { loc, kind: "block", body: [assign(num(2)), { loc, kind: "return", value: nested }] },
  ]));
  expect(ranges.get(before)).toEqual({ min: 1, max: 1 });
  expect(ranges.get(after)).toBeNull();
  expect(ranges.get(nested)).toEqual({ min: 3, max: 3 });
});

test("shared expression objects never inherit a proof from another occurrence", () => {
  const shared = ref();
  const ranges = analyzeIntegerRanges(fn([
    assign(num(1)), { loc, kind: "exprStmt", expr: shared }, assign(num(Infinity)),
    { loc, kind: "return", value: { loc, kind: "call", callee: "unknown", args: [shared], type: F64 } },
  ]));
  expect(ranges.get(shared)).toBeNull();
});
