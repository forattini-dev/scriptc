import { expect, test } from "vitest";
import { validateBunSpawn } from "./bun-spawn.js";
import { F64, STRING, NULL_T, LIB_NONDETERMINISTIC_PREFIXES, MAY_THROW_LIB_FNS, type IrExpr } from "./ir.js";

test("Bun subprocess IR rejects unsupported stdio modes and wrong exitCode results", () => {
  const loc = { file: "test.ts", start: 0, end: 1 };
  const number: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
  const validate = (expr: Extract<IrExpr, { kind: "libCall" }>): string[] => {
    const errors: string[] = [];
    validateBunSpawn(expr, id => ({ id, arms: [F64, NULL_T] }), message => errors.push(message));
    return errors;
  };
  const spawn: Extract<IrExpr, { kind: "libCall" }> = { kind: "libCall", fn: "bun.spawn", args: [number, number, number, number], type: { kind: "child" }, loc };
  expect(validate(spawn)).toEqual([]);
  expect(validate({ ...spawn, args: [number, number, { ...number, value: 3 }, number] })).toEqual(["libCall bun.spawn arg 2 must be a literal ignore/inherit mode"]);
  expect(validate({ ...spawn, fn: "bun.exitCode", type: STRING })).toEqual(["libCall bun.exitCode must return number | null"]);
  expect(validate({ ...spawn, fn: "bun.exitCode", type: { kind: "union", unionId: "nullable" } })).toEqual([]);
});

test("Bun subprocess operations expose ambient authority and synchronous spawn failures to IR analyses", () => {
  expect(MAY_THROW_LIB_FNS.has("bun.spawn")).toBe(true);
  for (const fn of ["bun.spawn", "bun.exited", "bun.pid", "bun.exitCode"]) {
    expect(LIB_NONDETERMINISTIC_PREFIXES.some(([prefix]) => fn.startsWith(prefix)), fn).toBe(true);
  }
});
