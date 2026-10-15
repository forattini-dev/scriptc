import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrExpr, type IrModule } from "./ir.js";
import { serializeModule, deserializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";

const loc = { file: "tuple.ts", start: 0, end: 1 };
function fixture(): { module: IrModule; expression: Extract<IrExpr, { kind: "intrinsic" }> } {
  const text: IrExpr = { kind: "strLit", value: "a", type: STRING, loc };
  const number: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
  const expression: Extract<IrExpr, { kind: "intrinsic" }> = {
    kind: "intrinsic", name: "promise.allTuple", loc,
    args: [text, number].map(value => ({ kind: "intrinsic", name: "promise.resolve", args: [value], type: { kind: "promise", inner: value.type }, loc })),
    type: { kind: "promise", inner: { kind: "record", shapeId: "tuple" } },
  };
  const module: IrModule = { irVersion: 13, sourceFile: loc.file, entry: "main",
    records: [{ id: "tuple", tuple: true, fields: [{ name: "0", type: STRING }, { name: "1", type: F64 }] }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr: expression, loc }], loc }],
  };
  return { module, expression };
}

test("heterogeneous Promise.all IR survives serialization with its slot types", () => {
  const { module } = fixture();
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
});

test("heterogeneous Promise.all IR rejects reordered or missing entries", () => {
  const { module, expression } = fixture();
  expression.args.reverse();
  expect(validateModule(module).filter(error => error.message.includes("promise.allTuple entry"))).toHaveLength(2);
  expression.args.pop();
  expect(validateModule(module)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("result tuple matching") }));
});

test("heterogeneous Promise.all IR requires promises and a tuple result", () => {
  const { module, expression } = fixture();
  expression.args[0] = { kind: "strLit", value: "plain", type: STRING, loc };
  expect(validateModule(module)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("entry 0") }));
  delete module.records![0]!.tuple;
  expect(validateModule(module)).toContainEqual(expect.objectContaining({ message: expect.stringContaining("result tuple matching") }));
});
