import { expect, test } from "vitest";
import { BOOL, DYN, F64, MAY_THROW_LIB_FNS, STRING, UNDEFINED_T, VOID, arrayOf, type IrExpr, type IrModule, type IrType } from "./ir.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";

const loc = { file: "numeric-read.ts", start: 0, end: 0 };

function numericReadModule(overrides: Partial<IrExpr & { kind: "arrIntrinsic" }> = {}): IrModule {
  const read: IrExpr = {
    kind: "arrIntrinsic", method: "getNumber",
    receiver: { kind: "arrayLit", elems: [], type: arrayOf(F64), loc },
    args: [{ kind: "numLit", value: 0, type: F64, loc }],
    type: F64, loc, ...overrides,
  };
  return {
    irVersion: 12, sourceFile: loc.file, entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr: read, loc }], loc }],
  };
}

test("numeric array-read intrinsic validates and round-trips", () => {
  const mod = numericReadModule();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("computed dynamic assignment validates its unconverted key ABI and throwing effect", () => {
  const mod = numericReadModule();
  const value: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const write: IrExpr = { kind: "libCall", fn: "dyn.keySetComputed", args: [value, value, value], type: VOID, loc };
  const entry = mod.functions[0];
  if (!entry) throw new Error("expected an entry function");
  entry.body = [{ kind: "exprStmt", expr: write, loc }];
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  expect(MAY_THROW_LIB_FNS.has("dyn.keySetComputed")).toBe(true);
  write.args[1] = { kind: "strLit", value: "key", type: STRING, loc };
  expect(validateModule(mod).length).toBeGreaterThan(0);
  write.args = [value, value, value];
  write.type = DYN;
  expect(validateModule(mod).length).toBeGreaterThan(0);
});

test("omitted process.exit code validates as a zero-argument terminating call", () => {
  const mod = numericReadModule();
  const entry = mod.functions[0]!;
  entry.returnType = F64;
  const exit: IrExpr = { kind: "libCall", fn: "process.exitDefault", args: [], type: VOID, loc };
  entry.body = [{ kind: "exprStmt", expr: exit, loc }];
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  exit.args = [{ kind: "numLit", value: 0, type: F64, loc }];
  expect(validateModule(mod).some(error => error.message.includes("1 args, expected 0"))).toBe(true);
  exit.args = [];
  exit.type = F64;
  expect(validateModule(mod).length).toBeGreaterThan(0);
});

test("process.exitCode read validates and round-trips its optional number", () => {
  const mod = numericReadModule();
  mod.unions = [{ id: "exitCode", arms: [F64, UNDEFINED_T] }];
  mod.functions[0]!.body = [{
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "process.currentExitCode", args: [], type: { kind: "union", unionId: "exitCode" }, loc },
    loc,
  }];
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);

  const read = mod.functions[0]!.body[0]!;
  if (read.kind !== "exprStmt") throw new Error("expected exitCode read");
  for (const type of [F64, VOID, { kind: "union", unionId: "missing" }] satisfies IrType[]) {
    read.expr.type = type;
    expect(validateModule(mod).some(error => error.message.includes("number | undefined"))).toBe(true);
  }
  read.expr.type = { kind: "union", unionId: "exitCode" };
  mod.unions[0]!.arms = [STRING, UNDEFINED_T];
  expect(validateModule(mod).some(error => error.message.includes("number | undefined"))).toBe(true);
});

test("indexed equality validates primitive kinds, arguments, and result", () => {
  const args: IrExpr[] = [
    { kind: "numLit", value: 0, type: F64, loc },
    { kind: "arrayLit", elems: [], type: arrayOf(F64), loc },
    { kind: "numLit", value: 1, type: F64, loc },
  ];
  const mod = numericReadModule({ method: "indexEq", args, type: BOOL });
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  for (const override of [
    { args: [] }, { type: F64 },
    { args: [args[0]!, { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc }, args[2]!] },
    { receiver: { kind: "arrayLit", elems: [], type: arrayOf(arrayOf(F64)), loc } },
  ] satisfies Partial<IrExpr & { kind: "arrIntrinsic" }>[]) {
    expect(validateModule(numericReadModule({ method: "indexEq", args, type: BOOL, ...override }))).not.toEqual([]);
  }
});

test.each([
  [{ receiver: { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc } }, "requires f64 elements"],
  [{ args: [] }, "0 args, expected 1"],
  [{ args: [{ kind: "strLit", value: "0", type: STRING, loc }] }, "arg 0: expected f64"],
  [{ type: BOOL }, "must be f64"],
] satisfies [Partial<IrExpr & { kind: "arrIntrinsic" }>, string][])("numeric array-read intrinsic rejects malformed IR %#", (overrides, message) => {
  expect(validateModule(numericReadModule(overrides)).some((error) => error.message.includes(message))).toBe(true);
});
