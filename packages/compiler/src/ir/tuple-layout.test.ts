import { expect, test } from "vitest";
import { STRING, VOID, type IrModule } from "./ir.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";

const loc = { file: "tuple-layout.ts", start: 0, end: 1 };
function emptyTuple(): IrModule {
  return {
    irVersion: 13, sourceFile: loc.file, entry: "main",
    records: [{ id: "empty", tuple: true, fields: [] }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, loc,
      body: [{ kind: "exprStmt", loc, expr: {
        kind: "recordLit", fields: [], type: { kind: "record", shapeId: "empty" }, loc,
      } }],
    }],
  };
}

test("zero arity tuples have a dense positional layout through serialization", () => {
  const module = emptyTuple();
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
});

test("zero arity tuples cannot acquire an index signature", () => {
  const module = emptyTuple();
  module.records![0]!.indexValue = STRING;
  expect(validateModule(module)).toContainEqual(expect.objectContaining({
    message: "record empty: a tuple cannot carry an index signature",
  }));
});

test("nonempty tuples still require every positional field", () => {
  const module = emptyTuple();
  module.records![0]!.fields.push({ name: "1", type: STRING });
  expect(validateModule(module)).toContainEqual(expect.objectContaining({
    message: 'record empty: tuple fields are not "0".."0"',
  }));
});
