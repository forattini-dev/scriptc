import { expect, test } from "vitest";
import type { IrExpr, IrFunction } from "../../ir/ir.js";
import { RustIntegerCallPlan } from "./integer-calls.js";

const loc = { file: "numeric-helper.ts", start: 0, end: 1 };
const f64 = { kind: "f64" } as const;
const byte = { min: 0, max: 255 };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: f64, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: f64, loc });
function helper(): IrFunction {
  return { name: "arbitraryHelper", params: [{ localId: "a", name: "a", type: f64 }],
    locals: [{ id: "a", name: "a", type: f64, mutable: true }], returnType: f64,
    body: [{ kind: "return", value: ref("a"), loc }], loc };
}

test("numeric bodies preserve argument evaluation through closed stack parameters", () => {
  const fn = helper();
  fn.body = [{ kind: "if", cond: { kind: "bin", op: "<", left: ref("a"), right: num(0), type: { kind: "bool" }, loc },
    then: [{ kind: "return", value: num(7), loc }], else_: null, loc },
  { kind: "return", value: { kind: "libCall", fn: "math.abs", args: [ref("a")], type: f64, loc }, loc }];
  const original = structuredClone(fn);
  const plan = RustIntegerCallPlan.build(fn, [{ min: -255, max: 255 }]);
  expect(plan?.range).toEqual(byte);
  expect(plan?.emit(["read_once()"])).toMatch(/^\(\|sc_numeric_sc_l_a: i64\| -> i64/);
  expect(plan?.emit(["read_once()"])).toMatch(/\)\(read_once\(\)\)$/);
  expect(fn).toEqual(original);
  fn.name = "renamed";
  expect(RustIntegerCallPlan.build(fn, [{ min: -255, max: 255 }])?.range).toEqual(byte);
});

test("intermediate overflow, fractions and negative zero refuse integer specialization", () => {
  const fn = helper();
  for (const value of [-0, 0.5, NaN, Infinity]) {
    fn.body = [{ kind: "return", value: num(value), loc }];
    expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
  }
  fn.body = [{ kind: "return", value: { kind: "bin", op: "*", left: ref("a"), right: num(-1), type: f64, loc }, loc }];
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
  expect(RustIntegerCallPlan.build(fn, [{ min: 1, max: 255 }])?.range).toEqual({ min: -255, max: -1 });
  fn.body = [{ kind: "return", value: { kind: "bin", op: "+", left: ref("a"), right: num(Number.MAX_SAFE_INTEGER), type: f64, loc }, loc }];
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
});

test("effects, ambient state, recursive calls and incomplete control flow are rejected", () => {
  const fn = helper();
  const original = structuredClone(fn.body);
  fn.body.unshift({ kind: "assign", localId: "a", value: num(1), loc });
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
  fn.body = [{ kind: "return", value: { kind: "call", callee: fn.name, args: [ref("a")], type: f64, loc }, loc }];
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
  fn.body = [{ kind: "return", value: ref("outside"), loc }];
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
  fn.body = [{ kind: "if", cond: { kind: "boolLit", value: true, type: { kind: "bool" }, loc }, then: original, else_: null, loc }];
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
  fn.body = original;
  fn.syncModuleCacheGlobal = "%cache";
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
  delete fn.syncModuleCacheGlobal;
  fn.captures = [];
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
});

test("specialization has a bounded expression and control flow budget", () => {
  const fn = helper();
  let expression = ref("a");
  for (let i = 0; i < 40; i++) expression = { kind: "bin", op: "+", left: expression, right: num(1), type: f64, loc };
  fn.body = [{ kind: "return", value: expression, loc }];
  expect(RustIntegerCallPlan.build(fn, [byte])).toBeNull();
});
