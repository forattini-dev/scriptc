import { expect, test } from "vitest";
import { BOOL, DYN, F64, STRING, VOID, type IrExpr, type IrModule, type IrType, type IrUnionDef } from "./ir.js";
import { serializeModule, deserializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";
const loc = { file: "validation-fields.ts", start: 0, end: 0 };
function expressionModule(expr: IrExpr, unions: IrUnionDef[]): IrModule { return { irVersion: 13, sourceFile: loc.file, entry: "main", unions, functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [{kind:"exprStmt",expr,loc}], loc }] }; }
test("record declarations accept forward, mutual, and self references and refresh missing IDs", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.records = [
    { id: "first", fields: [{ name: "next", type: { kind: "record", shapeId: "second" } }] },
    { id: "second", fields: [{ name: "next", type: { kind: "record", shapeId: "first" } }] },
    { id: "self", fields: [{ name: "next", type: { kind: "record", shapeId: "self" } }] },
  ];
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  mod.records[1]!.fields.unshift({ name: "missing", type: { kind: "record", shapeId: "later" } });
  expect(validateModule(mod)).toEqual([
    { message: 'record second: field "missing" references undeclared shape "later"', loc },
  ]);
  mod.records.push({ id: "later", fields: [] });
  expect(validateModule(mod)).toEqual([]);
});

function recordValidationModule(): IrModule {
  const type: IrType = { kind: "record", shapeId: "row" };
  const source: IrExpr = { kind: "varRef", localId: "row", type, loc };
  const mod = expressionModule({ kind: "recordGet", obj: source, shapeId: "row", field: "value", type: STRING, loc }, []);
  mod.records = [{ id: "row", fields: [{ name: "value", type: STRING }] }];
  mod.functions[0]!.locals = [{ id: "row", name: "row", type, mutable: false }];
  mod.functions[0]!.params = [{ localId: "row", name: "row", type }];
  mod.functions[0]!.body.push(
    { kind: "recordSet", obj: source, shapeId: "row", field: "value", value: { kind: "strLit", value: "write", type: STRING, loc }, loc },
    { kind: "exprStmt", expr: { kind: "recordClone", source, overrides: [{ name: "value", value: { kind: "strLit", value: "clone", type: STRING, loc } }], type, loc }, loc },
  );
  return mod;
}

test("record validation preserves first-field reads and writes and last-field initialization on duplicate declarations", () => {
  const mod = recordValidationModule();
  expect(validateModule(mod)).toEqual([]);
  mod.records!.unshift({ id: "row", fields: [{ name: "value", type: BOOL }] });
  mod.records![1]!.fields.push({ name: "value", type: F64 });
  const statement = mod.functions[0]!.body[2]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "recordClone") throw new Error("fixture");
  statement.expr.overrides[0]!.value = { kind: "numLit", value: 1, type: F64, loc };
  mod.functions[0]!.body.push({ kind: "exprStmt", expr: { kind: "recordLit", type: statement.expr.type, loc,
    fields: [1, 2].map((value) => ({ name: "value", value: { kind: "numLit", value, type: F64, loc } })),
  }, loc });
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([
    { message: 'duplicate record shape "row"', loc },
    { message: 'record row: duplicate field "value"', loc },
    { message: 'in main: recordLit initializes field "value" twice', loc },
  ]);
});

test("record validation refreshes field types and missing members between invocations", () => {
  const mod = recordValidationModule();
  expect(validateModule(mod)).toEqual([]);
  mod.records![0]!.fields[0]!.type = F64;
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in main: recordGet row.value type mismatch",
    "in main: recordSet row.value: expected f64, got string",
    'in main: recordClone field "value": expected f64, got string',
  ]);
  mod.records![0]!.fields = [];
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'in main: shape row has no field "value"',
    'in main: shape row has no field "value"',
    'in main: shape row has no field "value"',
  ]);
});

test("record clone validation refreshes accessor boundaries and preserves call-site locations across functions", () => {
  const mod = recordValidationModule();
  const statement = mod.functions[0]!.body[2]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "recordClone") throw new Error("fixture");
  mod.functions[0]!.body = [statement];
  mod.functions.push({ ...structuredClone(mod.functions[0]!), name: "other" });
  const other = mod.functions[1]!.body[0]!;
  if (other.kind !== "exprStmt") throw new Error("fixture");
  other.expr.loc = { ...loc, start: 10, end: 20 };
  expect(validateModule(mod)).toEqual([]);
  mod.records![0]!.fields.unshift({ name: "%get:value", type: F64 });
  expect(validateModule(mod)).toEqual([
    { message: "in main: recordClone requires a plain declared-field shape, got row", loc },
    { message: "in other: recordClone requires a plain declared-field shape, got row", loc: other.expr.loc },
  ]);
});

function classFieldModule(): IrModule {
  const type: IrType = { kind: "object", className: "Value" };
  const source: IrExpr = { kind: "varRef", localId: "object", type, loc };
  const union: IrType = { kind: "union", unionId: "variants" };
  const mod = expressionModule({ kind: "fieldGet", obj: source, className: "Value", field: "score", type: F64, loc }, [
    { id: "variants", arms: [type, { kind: "record", shapeId: "row" }] },
  ]);
  mod.classes = [{ name: "Value", fields: [{ name: "score", type: F64 }, { name: "dynamic", type: DYN }], loc }];
  mod.records = [{ id: "row", fields: [{ name: "score", type: F64 }] }];
  mod.functions[0]!.params = [{ localId: "object", name: "object", type }, { localId: "variant", name: "variant", type: union }];
  mod.functions[0]!.locals = [{ id: "object", name: "object", type, mutable: false }, { id: "variant", name: "variant", type: union, mutable: false }];
  mod.functions[0]!.body.push(
    { kind: "fieldSet", obj: source, className: "Value", field: "score", value: { kind: "numLit", value: 1, type: F64, loc }, loc },
    { kind: "exprStmt", expr: { kind: "fieldIncDec", obj: source, className: "Value", field: "score", fieldDyn: false, op: "+", prefix: true, type: F64, loc }, loc },
    { kind: "exprStmt", expr: { kind: "fieldIncDec", obj: source, className: "Value", field: "dynamic", fieldDyn: true, op: "-", prefix: false, type: F64, loc }, loc },
    { kind: "exprStmt", expr: { kind: "unionDisc", value: { kind: "varRef", localId: "variant", type: union, loc }, unionId: "variants", field: "score", type: F64, loc }, loc },
  );
  return mod;
}

test("class field validation preserves last-class and first-field lookup on duplicate declarations", () => {
  const mod = classFieldModule();
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  mod.classes!.unshift({ name: "Value", fields: [{ name: "score", type: STRING }, { name: "dynamic", type: F64 }], loc });
  mod.classes![1]!.fields.push({ name: "score", type: STRING }, { name: "dynamic", type: F64 });
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([
    { message: 'duplicate class "Value"', loc },
    { message: 'class Value: duplicate field "score"', loc },
    { message: 'class Value: duplicate field "dynamic"', loc },
  ]);
});

test("class field validation refreshes types, missing fields, and missing classes between invocations", () => {
  const mod = classFieldModule();
  expect(validateModule(mod)).toEqual([]);
  mod.classes![0]!.fields[0]!.type = STRING;
  mod.classes![0]!.fields[1]!.type = F64;
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in main: fieldGet Value.score type mismatch",
    "in main: fieldSet Value.score: expected string, got f64",
    "in main: fieldIncDec Value.score field/flag mismatch (string)",
    "in main: fieldIncDec Value.dynamic field/flag mismatch (f64)",
    'in main: unionDisc: arm 0 field "score" is string, not f64',
  ]);
  mod.classes![0]!.fields = [];
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'in main: class Value has no field "score"',
    'in main: class Value has no field "score"',
    'in main: class Value has no field "score"',
    'in main: class Value has no field "dynamic"',
    'in main: unionDisc: arm 0 of variants has no field "score"',
  ]);
  mod.classes = [];
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'in main: fieldGet on undeclared class "Value"',
    'in main: fieldSet on undeclared class "Value"',
    'in main: fieldIncDec on undeclared class "Value"',
    'in main: fieldIncDec on undeclared class "Value"',
    'in main: unionDisc: arm 0 of variants has no field "score"',
  ]);
});

test("class field validation shares inherited layouts across functions and preserves call-site diagnostics", () => {
  const mod = classFieldModule();
  mod.classes!.unshift({ name: "Base", fields: structuredClone(mod.classes![0]!.fields), loc });
  mod.classes![1]!.base = "Base";
  const other = structuredClone(mod.functions[0]!);
  other.name = "other";
  other.body = other.body.slice(0, 1);
  mod.functions.push(other);
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  const statement = other.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "fieldGet") throw new Error("fixture");
  statement.expr.loc = { ...loc, start: 10, end: 20 };
  statement.expr.type = STRING;
  statement.expr.obj = { kind: "numLit", value: 0, type: F64, loc };
  expect(validateModule(mod)).toEqual([
    { message: "in other: fieldGet receiver: expected object, got f64", loc },
    { message: "in other: fieldGet Value.score type mismatch", loc: statement.expr.loc },
  ]);
});
