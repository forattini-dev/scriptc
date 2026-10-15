import { expect, test } from "vitest";
import { DYN, STRING, VOID, type IrExpr, type IrModule } from "./ir.js";
import { serializeModule, deserializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";

const loc = { file: "function-length.ts", start: 0, end: 1 };
function moduleWithLength(length: number): IrModule {
  const type = { kind: "func", params: [STRING], ret: VOID } as const;
  const boxed: IrExpr = { kind: "dynFrom", value: { kind: "closure", fnName: "target", captures: [], type: { ...type, params: [STRING] }, loc }, fnLength: length, type: DYN, loc };
  return { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [
    { name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr: boxed, loc }], loc },
    { name: "target", params: [{ localId: "arg", name: "arg", type: STRING }], locals: [{ id: "arg", name: "arg", type: STRING, mutable: true }], returnType: VOID, body: [], loc },
  ] };
}

test.each([0, 1])("function arity %s survives the IR round-trip independently of ABI", length => {
  const module = moduleWithLength(length);
  const restored = deserializeModule(serializeModule(module));
  expect(restored).toEqual(module);
  expect(validateModule(restored)).toEqual([]);
});

test.each([-1, 0.5, 2, NaN, Infinity])("function arity rejects invalid metadata %s", length => {
  expect(validateModule(moduleWithLength(length))).toContainEqual(expect.objectContaining({ message: expect.stringContaining("dynFrom fnLength") }));
});

test("function arity metadata cannot decorate a non-function value", () => {
  const module = moduleWithLength(0);
  const statement = module.functions[0]!.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "dynFrom") throw new Error("missing boxing");
  statement.expr.value = { kind: "strLit", value: "text", type: STRING, loc };
  expect(validateModule(module)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("dynFrom fnLength") }));
});

test("one closure target cannot declare conflicting arities", () => {
  const module = moduleWithLength(0);
  const main = module.functions[0]!;
  const statement = main.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "dynFrom") throw new Error("missing boxing");
  main.body.push({ ...statement, expr: { ...statement.expr, fnLength: 1 } });
  expect(validateModule(module)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("conflicting fnLength") }));
});

test("different targets sharing an ABI may declare different arities", () => {
  const module = moduleWithLength(0);
  const other = moduleWithLength(1).functions[1]!;
  module.functions.push({ ...other, name: "other" });
  module.functions[0]!.body.push({ kind: "exprStmt", loc, expr: { kind: "dynFrom", fnLength: 1, type: DYN, loc,
    value: { kind: "closure", fnName: "other", captures: [], type: { kind: "func", params: [STRING], ret: VOID }, loc } } });
  expect(validateModule(module)).toEqual([]);
});
