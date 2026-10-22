import { expect, test } from "vitest";
import { DYN, F64, STRING, VOID, arrayOf, type IrExpr, type IrModule } from "./ir.js";
import { validateModule } from "./validate.js";
import { serializeModule, deserializeModule } from "./serialize.js";

const loc = { file: "json-functions.ts", start: 0, end: 1 };
function fixture(expr: IrExpr): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr, loc }], loc }] };
}
for (const fn of ["json.stringifyNative", "json.parseNative"] as const) {
  test(`${fn} retains a dynamic result and validates every argument pack`, () => {
    const value: IrExpr = { kind: "libCall", fn, args: [{ kind: "arrayLit", elems: [], type: arrayOf(DYN), loc }], type: DYN, loc };
    expect(validateModule(deserializeModule(serializeModule(fixture(value))))).toEqual([]);
    for (const invalid of [
      { ...value, type: STRING },
      { ...value, args: [] },
      { ...value, args: [{ kind: "arrayLit", elems: [], type: arrayOf(F64), loc }] },
    ] as IrExpr[]) expect(validateModule(fixture(invalid)).length).toBeGreaterThan(0);
  });
}
