import { expect, test } from "vitest";
import { F64, NULL_T, STRING, type IrRecordShape, type IrType, type IrUnionDef } from "./ir.js";
import { validDnsLookupPromiseResult } from "./dns-lookup.js";
import { nativeModuleBackendDiagnostics } from "../backend/native-module-support.js";
import { validateModule } from "./validate.js";
import { VOID, type IrExpr, type IrModule } from "./ir.js";

const address: IrType = { kind: "union", unionId: "u0" };
const addressField = { name: "address", type: address }, familyField = { name: "family", type: F64 };
const shape: IrRecordShape = { id: "r0", fields: [addressField, familyField] };
const result: IrType = { kind: "promise", inner: { kind: "record", shapeId: shape.id } };
const union: IrUnionDef = { id: "u0", arms: [NULL_T, STRING] };
const records = new Map([[shape.id, shape]]), unions = new Map([[union.id, union]]);

test("DNS promises retain the nullable address and numeric family ABI", () => {
  expect(validDnsLookupPromiseResult(result, records, unions)).toBe(true);
  expect(validDnsLookupPromiseResult(result, records, new Map([[union.id, { ...union, arms: [STRING, NULL_T] }]]))).toBe(true);
});

test("DNS result validation rejects missing, malformed and unrelated layouts", () => {
  for (const invalid of [
    { ...shape, fields: [] }, { ...shape, fields: [{ name: "address", type: STRING }, familyField] },
    { ...shape, fields: [addressField, { name: "family", type: STRING }] },
    { ...shape, tuple: true as const }, { ...shape, indexValue: STRING },
    { ...shape, fields: [...shape.fields, { name: "extra", type: F64 }] },
  ]) expect(validDnsLookupPromiseResult(result, new Map([[shape.id, invalid]]), unions)).toBe(false);
  for (const arms of [[STRING], [STRING, F64], [STRING, NULL_T, F64]]) {
    expect(validDnsLookupPromiseResult(result, records, new Map([[union.id, { ...union, arms }]]))).toBe(false);
  }
  expect(validDnsLookupPromiseResult(result, new Map(), unions)).toBe(false);
  expect(validDnsLookupPromiseResult(result, records, new Map())).toBe(false);
  expect(validDnsLookupPromiseResult(F64, records, unions)).toBe(false);
});

test.each(["dns.promises.lookup", "dns.lookupAsync"] as const)("%s validates as IR and retains explicit C/LLVM refusals", fn => {
  const loc = { file: "dns-lookup.ts", start: 0, end: 1 };
  const call: IrExpr = { kind: "libCall", fn, args: [
    { kind: "strLit", value: "::1", type: STRING, loc }, { kind: "numLit", value: 0, type: F64, loc },
    { kind: "strLit", value: "family", type: STRING, loc },
  ], type: result, loc };
  const module: IrModule = { irVersion: 12, sourceFile: loc.file, entry: "main", records: [shape], unions: [union], functions: [{
    name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr: call, loc }], loc,
  }] };
  expect(validateModule(module)).toEqual([]);
  expect(nativeModuleBackendDiagnostics(module, "rust")).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(module, backend)).toEqual([{
      code: "SC3001", loc, message: `the ${backend} backend does not support native ${fn} yet; use --backend rust`,
    }]);
  }
  expect(validateModule({ ...module, unions: [{ ...union, arms: [STRING, F64] }] })
    .some(error => error.message.includes(fn))).toBe(true);
});
