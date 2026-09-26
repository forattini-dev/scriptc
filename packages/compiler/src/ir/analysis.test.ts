import { expect, test } from "vitest";
import { isStableReceiverOperand, matchStringSelfConcat } from "./analysis.js";
import { BOOL, F64, STRING, arrayOf, bytesOf, type IrExpr, type IrLibFn } from "./ir.js";

const loc = { file: "analysis.ts", start: 0, end: 0 };
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string, type = STRING): IrExpr => ({ kind: "varRef", localId, type, loc });
const concat = (left: IrExpr, right: IrExpr, type = STRING): IrExpr => ({
  kind: "strConcat", left, right, type, loc,
});

test("matchStringSelfConcat recognizes only the immediate string self-concat", () => {
  const suffix = str("x");
  expect(matchStringSelfConcat("acc", concat(ref("acc"), suffix))).toBe(suffix);
});

test("matchStringSelfConcat rejects non-canonical and non-string shapes", () => {
  expect(matchStringSelfConcat("acc", concat(ref("other"), str("x")))).toBeNull();
  expect(matchStringSelfConcat("acc", concat(concat(ref("acc"), str("x")), str("y")))).toBeNull();
  expect(matchStringSelfConcat("acc", str("x"))).toBeNull();
  expect(matchStringSelfConcat("acc", concat(ref("acc", F64), str("x")))).toBeNull();
  expect(matchStringSelfConcat("acc", concat(ref("acc"), str("x"), F64))).toBeNull();
});

test("receiver borrowing accepts scalar index updates and stable byte reads", () => {
  const index: IrExpr = { kind: "assignExpr", localId: "index", value: ref("next", F64), type: F64, loc };
  const read: IrExpr = { kind: "bytesIntrinsic", method: "get", receiver: ref("bytes", bytesOf("u8")), args: [index], type: F64, loc };
  expect(isStableReceiverOperand(index, "values")).toBe(true);
  expect(isStableReceiverOperand(read, "values")).toBe(true);
});

test("receiver borrowing rejects replacement hidden inside numeric or byte indices", () => {
  const type = arrayOf(F64);
  const replace: IrExpr = { kind: "assignExpr", localId: "values", value: ref("replacement", type), type, loc };
  const index: IrExpr = {
    kind: "ternary", cond: { kind: "toBool", operand: replace, type: BOOL, loc },
    then: { kind: "numLit", value: 0, type: F64, loc }, else_: ref("index", F64), type: F64, loc,
  };
  const read: IrExpr = { kind: "bytesIntrinsic", method: "get", receiver: ref("bytes", bytesOf("u8")), args: [index], type: F64, loc };
  expect(isStableReceiverOperand(index, "values")).toBe(false);
  expect(isStableReceiverOperand(read, "values")).toBe(false);
});

test("receiver borrowing rejects calls even when nested in arithmetic", () => {
  const call: IrExpr = { kind: "call", callee: "index", args: [], type: F64, loc };
  const index: IrExpr = { kind: "bin", op: "+", left: ref("offset", F64), right: call, type: F64, loc };
  expect(isStableReceiverOperand(index, "values")).toBe(false);
});

const math = (fn: IrLibFn, ...args: IrExpr[]): IrExpr => ({ kind: "libCall", fn, args, type: F64, loc });

test("receiver borrowing accepts nested scalar Math operations and scalar index effects", () => {
  const increment: IrExpr = { kind: "incDec", localId: "index", op: "+", prefix: false, type: F64, loc };
  const index = math("math.floor", increment);
  const read: IrExpr = { kind: "bytesIntrinsic", method: "get", receiver: ref("bytes", bytesOf("u8")), args: [index], type: F64, loc };
  const value = math("math.min", math("math.abs", read), math("math.sqrt", ref("limit", F64)));
  expect(isStableReceiverOperand(value, "bytes")).toBe(true);
});

test("a Math wrapper cannot hide a call or receiver replacement in either argument", () => {
  const bytes = bytesOf("u8");
  const replace: IrExpr = { kind: "assignExpr", localId: "bytes", value: ref("other", bytes), type: bytes, loc };
  const condition: IrExpr = { kind: "toBool", operand: replace, type: BOOL, loc };
  const hidden: IrExpr = { kind: "ternary", cond: condition, then: ref("x", F64), else_: ref("y", F64), type: F64, loc };
  const call: IrExpr = { kind: "call", callee: "replace", args: [], type: F64, loc };
  for (const effect of [hidden, call]) {
    expect(isStableReceiverOperand(math("math.floor", effect), "bytes")).toBe(false);
    expect(isStableReceiverOperand(math("math.pow", ref("x", F64), math("math.abs", effect)), "bytes")).toBe(false);
    expect(isStableReceiverOperand(math("math.min", effect, ref("x", F64)), "bytes")).toBe(false);
  }
});

test("only audited scalar Math lowerings qualify, not reference arguments or other library calls", () => {
  expect(isStableReceiverOperand(math("math.minArr", ref("array", arrayOf(F64))), "bytes")).toBe(false);
  expect(isStableReceiverOperand(math("math.random"), "bytes")).toBe(false);
  expect(isStableReceiverOperand(math("num.fromString", str("3")), "bytes")).toBe(false);
  expect(isStableReceiverOperand(math("math.floor", str("3")), "bytes")).toBe(false);
});
