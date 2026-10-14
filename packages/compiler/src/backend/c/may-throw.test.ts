import { expect, test } from "vitest";
import { STRING, VOID, type IrFunction, type IrModule, type IrStmt } from "../../ir/ir.js";
import { computeMayThrow } from "./may-throw.js";

const loc = { file: "calls.ts", start: 0, end: 1 };
const call = (name: string): IrStmt => ({ kind: "exprStmt", expr: { kind: "call", callee: name, args: [], type: VOID, loc }, loc });
const failure: IrStmt = { kind: "throw", value: { kind: "strLit", value: "failed", type: STRING, loc }, loc };
const fn = (name: string, body: IrStmt[]): IrFunction => ({ name, body, params: [], locals: [], returnType: VOID, loc });
const moduleWith = (functions: IrFunction[]): IrModule => ({ irVersion: 13, sourceFile: loc.file, entry: functions[0]!.name, functions });

test("exception propagation is order-independent through long chains", () => {
  const functions = Array.from({ length: 6000 }, (_, index) => fn(`f${index}`, [index === 5999 ? failure : call(`f${index + 1}`)]));
  for (const order of [functions, [...functions].reverse()]) {
    expect(computeMayThrow(moduleWith(order))).toEqual({ fns: new Set(functions.map(value => value.name)), indirect: false });
  }
});

test("recursive components stay pure until they reach a throwing seed and refresh after mutation", () => {
  const module = moduleWith([fn("caller", [call("a"), call("a")]), fn("a", [call("b")]), fn("b", [call("a")]), fn("pure", [call("pure")])]);
  expect(computeMayThrow(module).fns.size).toBe(0);
  module.functions[2]!.body.push(failure);
  const snapshot = structuredClone(module);
  const answer = computeMayThrow(module);
  expect(answer.fns).toEqual(new Set(["caller", "a", "b"]));
  expect(module).toEqual(snapshot);
  module.functions[2]!.body.pop();
  expect(computeMayThrow(module).fns.size).toBe(0);
  expect(answer.fns.size).toBe(3);
});
