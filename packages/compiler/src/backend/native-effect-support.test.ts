import { expect, test } from "vitest";
import { BOOL, DYN, EFFECT_T, STRING, VOID, type IrExpr, type IrModule, type IrRecordShape, type IrType, type IrUnionDef } from "../ir/ir.js";
import { nativeEffectBackendDiagnostics } from "./native-effect-support.js";

const loc = { file: "effect-boundary.ts", start: 10, end: 30 };
const backends = ["c", "llvm"] as const;

function moduleWith(type: IrType, direction?: "box" | "check", records?: IrRecordShape[], unions?: IrUnionDef[]): IrModule {
  const sourceType = direction === "check" ? DYN : type;
  const source: IrExpr = { kind: "varRef", localId: "value.0", type: sourceType, loc };
  const expr: IrExpr = direction === "box" ? { kind: "dynFrom", value: source, type: DYN, loc }
    : direction === "check" ? { kind: "dynCheck", value: source, type, loc } : source;
  return { irVersion: 6, sourceFile: loc.file, entry: "main", ...(records ? { records } : {}), ...(unions ? { unions } : {}),
    functions: [
      { name: "main", params: [], locals: [], returnType: VOID, body: [], loc },
      { name: "probe", params: [{ localId: "value.0", name: "value", type: sourceType }],
        locals: [{ id: "value.0", name: "value", type: sourceType, mutable: false }],
        returnType: VOID, body: [{ kind: "exprStmt", expr, loc }], loc },
    ] };
}

function expectRefusal(mod: IrModule): void {
  for (const backend of backends) expect(nativeEffectBackendDiagnostics(mod, backend)).toEqual([{
    code: "SC3001", loc,
    message: `the ${backend} backend does not support native Effect identity comparisons or reference transport through dynamic slots yet; use --backend rust`,
  }]);
}

function comparisonModule(leftType: IrType, rightType: IrType, dynamic: boolean, negated: boolean): IrModule {
  const left: IrExpr = { kind: "varRef", localId: "left.0", type: leftType, loc };
  const right: IrExpr = { kind: "varRef", localId: "right.0", type: rightType, loc };
  const expr: IrExpr = dynamic ? { kind: "dynScalarEq", left, right, ...(negated ? { negated: true as const } : {}), type: BOOL, loc }
    : { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
  const mod = moduleWith(STRING);
  const params = [{ localId: "left.0", name: "left", type: leftType }, { localId: "right.0", name: "right", type: rightType }];
  mod.functions.push({ name: "compare", params,
    locals: params.map(param => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
    returnType: BOOL, body: [{ kind: "return", value: expr, loc }], loc });
  return mod;
}

test("Effect boxing and dynamic extraction refuse at the boundary location", () => {
  expectRefusal(moduleWith(EFFECT_T, "box"));
  expectRefusal(moduleWith(EFFECT_T, "check"));
});

test("strict Effect equality and inequality refuse even without a dynamic boundary", () => {
  expectRefusal(comparisonModule(EFFECT_T, EFFECT_T, false, false));
  expectRefusal(comparisonModule(EFFECT_T, EFFECT_T, false, true));
});

test("mixed dynamic Effect comparisons refuse in either operand order and polarity", () => {
  for (const negated of [false, true]) {
    expectRefusal(comparisonModule(EFFECT_T, DYN, true, negated));
    expectRefusal(comparisonModule(DYN, EFFECT_T, true, negated));
  }
});

test("boxed and adapted callbacks cannot transport Effect in parameters or nested results", () => {
  const signatures: IrType[] = [
    { kind: "func", params: [], ret: EFFECT_T },
    { kind: "func", params: [EFFECT_T], ret: VOID },
    { kind: "func", params: [], ret: { kind: "func", params: [STRING], ret: EFFECT_T } },
    { kind: "func", params: [{ kind: "func", params: [], ret: EFFECT_T }], ret: STRING },
  ];
  for (const type of signatures) {
    expectRefusal(moduleWith(type, "box"));
    expectRefusal(moduleWith(type, "check"));
  }
});

test("Effect transport is detected through container fields and tagged arms", () => {
  const record: IrType = { kind: "record", shapeId: "methods" };
  const union: IrType = { kind: "union", unionId: "optional" };
  const records: IrRecordShape[] = [{ id: "methods", fields: [
    { name: "work", type: { kind: "func", params: [], ret: EFFECT_T } },
  ] }, { id: "dictionary", fields: [], indexValue: union }];
  const unions: IrUnionDef[] = [{ id: "optional", arms: [record, { kind: "undefinedT" }] }];
  const types: IrType[] = [record, union, { kind: "record", shapeId: "dictionary" },
    { kind: "array", elem: union }, { kind: "map", key: STRING, value: { kind: "array", elem: record } },
    { kind: "promise", inner: record }, { kind: "set", elem: EFFECT_T },
  ];
  for (const type of types) for (const direction of ["box", "check"] as const) {
    expectRefusal(moduleWith(type, direction, records, unions));
  }
});

test("recursive shape traversal terminates and distinguishes record and union IDs", () => {
  const type: IrType = { kind: "record", shapeId: "same" };
  const records: IrRecordShape[] = [{ id: "same", fields: [
    { name: "next", type }, { name: "value", type: { kind: "union", unionId: "same" } },
  ] }];
  const union: IrUnionDef = { id: "same", arms: [type, EFFECT_T] };
  const unions = [union];
  expectRefusal(moduleWith(type, "box", records, unions));
  expectRefusal(moduleWith(type, "check", records, unions));
  union.arms = [type, STRING];
  for (const backend of backends) expect(nativeEffectBackendDiagnostics(moduleWith(type, "box", records, unions), backend)).toEqual([]);
});

test("static Effect types do not introduce a blanket backend refusal", () => {
  const type: IrType = { kind: "func", params: [EFFECT_T], ret: EFFECT_T };
  const mod = moduleWith(type);
  mod.records = [{ id: "static", fields: [{ name: "effect", type: EFFECT_T }] }];
  mod.unions = [{ id: "static", arms: [EFFECT_T, { kind: "undefinedT" }] }];
  const effect: IrExpr = { kind: "libCall", fn: "effect.succeed", args: [
    { kind: "strLit", value: "ok", type: STRING, loc },
  ], type: EFFECT_T, loc };
  mod.functions.push({ name: "existingStaticEffect", params: [], locals: [], returnType: STRING,
    body: [{ kind: "return", value: { kind: "libCall", fn: "effect.runSync", args: [effect], type: STRING, loc }, loc }], loc });
  for (const backend of backends) expect(nativeEffectBackendDiagnostics(mod, backend)).toEqual([]);
});

test("unrelated identity comparisons keep their backend policy with static Effect metadata", () => {
  for (const negated of [false, true]) {
    for (const dynamic of [false, true]) {
      const mod = comparisonModule(dynamic ? DYN : STRING, dynamic ? DYN : STRING, dynamic, negated);
      mod.records = [{ id: "unused", fields: [{ name: "effect", type: EFFECT_T }] }];
      for (const backend of backends) expect(nativeEffectBackendDiagnostics(mod, backend)).toEqual([]);
    }
  }
});

test("unrelated dynamic boundaries remain available even with static Effect metadata", () => {
  for (const direction of ["box", "check"] as const) {
    const type: IrType = { kind: "func", params: [STRING], ret: STRING };
    const mod = moduleWith(type, direction, [{ id: "unused", fields: [{ name: "effect", type: EFFECT_T }] }]);
    for (const backend of backends) expect(nativeEffectBackendDiagnostics(mod, backend)).toEqual([]);
  }
});
