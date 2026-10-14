import { expect, test } from "vitest";
import { BOOL, F64, STRING, VOID, arrayOf, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitRustModule } from "./emitter.js";

const loc = { file: "array-scalars.ts", start: 0, end: 1 };
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const array = (elem: IrType): IrExpr => ({ kind: "arrayLit", elems: [], type: arrayOf(elem), loc });
function moduleFor(expr: IrExpr): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [
    { name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr, loc }], loc },
  ] };
}

test.each([F64, BOOL, STRING])("primitive indexed comparison emits strict equality and preserves the IR: $kind", elem => {
  const module = moduleFor({ kind: "arrIntrinsic", method: "indexEq", receiver: array(elem), args: [number(0), array(elem), number(1)], type: BOOL, loc });
  expect(validateModule(module)).toEqual([]);
  const before = structuredClone(module);
  const rust = emitRustModule(module);
  expect(rust).toContain("runtime::array_index_equal_by(");
  if (elem.kind === "f64") expect(rust).toContain("*left == *right");
  expect(module).toEqual(before);
});

test("numeric array coercion emits its absence-aware scalar read", () => {
  const module = moduleFor({ kind: "arrIntrinsic", method: "getNumber", receiver: array(F64), args: [number(9)], type: F64, loc });
  expect(validateModule(module)).toEqual([]);
  expect(emitRustModule(module)).toContain("runtime::array_get_number(");
});
