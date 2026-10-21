import { expect, test } from "vitest";
import { CHILD_T, DYN, F64, STRING, VOID, arrayOf, canDynCheckTo, isSupportedArrayElem, type IrExpr, type IrModule, type IrType } from "./ir.js";
import { validateModule } from "./validate.js";

const loc = { file: "exec-file.ts", start: 0, end: 1 };
const result: IrType = { kind: "promise", inner: { kind: "record", shapeId: "capture" } };
const capture: IrExpr = { kind: "libCall", fn: "cp.execFilePromise", args: [{ kind: "arrayLit", elems: [], type: arrayOf(DYN), loc }], type: result, loc };
function fixture(value: IrExpr): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "main", records: [{ id: "capture", fields: [{ name: "stderr", type: STRING }, { name: "stdout", type: STRING }] }], functions: [
    { name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr: value, loc }], loc },
  ] };
}

test("native execFile validates its dynamic arguments and closed capture ABI", () => {
  expect(validateModule(fixture(capture))).toEqual([]);
  for (const malformed of [
    { ...capture, type: CHILD_T },
    { ...capture, args: [] },
    { ...capture, args: [{ kind: "numLit", value: 1, type: F64, loc }] },
  ] as IrExpr[]) expect(validateModule(fixture(malformed)).length).toBeGreaterThan(0);
  const invalid = fixture(capture);
  invalid.records![0]!.fields[1]!.type = F64;
  expect(validateModule(invalid).length).toBeGreaterThan(0);
});

test("Promise payload checks preserve their native boundary and child handles", () => {
  expect(canDynCheckTo(result, id => fixture(capture).records!.find(record => record.id === id), () => undefined)).toBe(true);
  expect(isSupportedArrayElem(DYN)).toBe(false);
  expect(isSupportedArrayElem(DYN, true)).toBe(true);
  const child: IrExpr = { kind: "libCall", fn: "cp.promiseChild", args: [capture], type: CHILD_T, loc };
  expect(validateModule(fixture(child))).toEqual([]);
  expect(validateModule(fixture({ ...child, args: [{ kind: "numLit", value: 0, type: F64, loc }] })).length).toBeGreaterThan(0);
});
