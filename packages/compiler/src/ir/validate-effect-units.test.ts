import { expect, test } from "vitest";
import { type IrExpr, type IrModule } from "./nodes.js";
import { validateModule } from "./validate.js";
import { deserializeModule, serializeModule } from "./serialize.js";

const loc = { file: "effect-units.ts", start: 0, end: 1 };
const nil: IrExpr = { kind: "unitLit", unit: "null", type: { kind: "nullT" }, loc };

function moduleWith(expr: IrExpr): IrModule {
  return {
    irVersion: 6, sourceFile: loc.file, entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: { kind: "void" },
      body: [{ kind: "exprStmt", expr, loc }], loc }],
  };
}

test("boxed Effect units validate and survive serialization", () => {
  const module = moduleWith({ kind: "libCall", fn: "effect.succeed", args: [nil], type: { kind: "effect" }, loc });
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
});

test("runSyncExit requires an Effect input and retains its Exit handle type", () => {
  const source: IrExpr = { kind: "libCall", fn: "effect.succeed", args: [nil], type: { kind: "effect" }, loc };
  const runner: IrExpr = { kind: "libCall", fn: "effect.runSyncExit", args: [source], type: { kind: "effect" }, loc };
  const module = moduleWith(runner);
  expect(validateModule(module)).toEqual([]);
  expect(deserializeModule(serializeModule(module))).toEqual(module);
  expect(validateModule(moduleWith({ ...runner, args: [] }))).not.toEqual([]);
  expect(validateModule(moduleWith({ ...runner, args: [{ kind: "numLit", value: 1, type: { kind: "f64" }, loc }] }))).not.toEqual([]);
  expect(validateModule(moduleWith({ ...runner, type: { kind: "f64" } }))).not.toEqual([]);
});

test("boxing does not excuse a unit literal with the wrong type", () => {
  const module = moduleWith({ kind: "libCall", fn: "effect.fail",
    args: [{ kind: "unitLit", unit: "null", type: { kind: "undefinedT" }, loc }], type: { kind: "effect" }, loc });
  expect(validateModule(module).map((error) => error.message)).toEqual([
    expect.stringContaining("unitLit 'null' typed undefinedT"),
  ]);
});

test("bare units remain invalid outside payload slots, including Effect callbacks", () => {
  expect(validateModule(moduleWith(nil)).map((error) => error.message)).toContainEqual(expect.stringContaining("bare unitLit"));
  const module = moduleWith({ kind: "libCall", fn: "effect.sync", args: [nil], type: { kind: "effect" }, loc });
  expect(validateModule(module).map((error) => error.message)).toContainEqual(expect.stringContaining("bare unitLit"));
});
