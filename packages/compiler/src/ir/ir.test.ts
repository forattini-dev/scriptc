import { arrayOf, funcOf, typeKey, typeEquals, canBoxFuncIntoDyn, canAdaptDynFuncTo, canConvertToDyn, canMarshalTypedFuncIntoIsland } from "./ir.js";
import { validateModule } from "./validate.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { describe, expect, test } from "vitest";
import {
  DYN,
  F64,
  HANDLE_KINDS,
  POINTER_KINDS,
  STRING,
  VOID,
  moduleUsesDynAsync,
  moduleHasLibCall,
  type IrExpr,
  type IrModule,
  type IrRecordShape,
  type IrType,
} from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 1 };

test("recursive records through function results terminate and retain unsupported-member refusals", () => {
  const record: IrType = { kind: "record", shapeId: "factory" };
  const factory = funcOf([], record);
  const shape: IrRecordShape = { id: "factory", fields: [{ name: "clone", type: factory }] };
  const records = new Map([[shape.id, shape]]);
  const getRecord = (id: string): IrRecordShape | undefined => records.get(id);
  expect(canConvertToDyn(record, getRecord, () => undefined)).toBe(true);
  expect(canBoxFuncIntoDyn(factory, getRecord, () => undefined)).toBe(true);

  // A cycle does not excuse a non-boxable field elsewhere in the graph.
  // Checking the factory twice also catches stale visitation state from
  // a failed speculative walk/fallback.
  shape.fields.push({ name: "unsupported", type: { kind: "bytes", elem: "u32" } });
  expect(canConvertToDyn(record, getRecord, () => undefined)).toBe(false);
  expect(canConvertToDyn(factory, getRecord, () => undefined)).toBe(false);
  expect(canBoxFuncIntoDyn(factory, getRecord, () => undefined)).toBe(false);
});

function moduleWithExpr(expr: IrExpr): IrModule {
  return {
    irVersion: 12,
    sourceFile: loc.file,
    functions: [{
      name: "main",
      params: [],
      returnType: VOID,
      locals: [],
      body: [{ kind: "exprStmt", expr, loc }],
      loc,
    }],
    entry: "main",
  };
}

function ref(type: IrType): IrExpr {
  return { kind: "varRef", localId: "value.0", type, loc };
}

test.each(["dyn.objectRestCheck", "dyn.objectAssignSourceCheck"] as const)("%s validates, round-trips and is found inside nested initializers", fn => {
  const source: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const guard: IrExpr = { kind: "libCall", fn, args: [source], type: VOID, loc };
  const module = moduleWithExpr({
    kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: guard, loc }], result: source, type: DYN, loc,
  });
  expect(validateModule(module)).toEqual([]);
  expect(moduleHasLibCall(module, fn)).toBe(true);
  expect(moduleHasLibCall(module, "dyn.defineProps")).toBe(false);
  const restored = deserializeModule(serializeModule(module));
  expect(validateModule(restored)).toEqual([]);
  expect(moduleHasLibCall(restored, fn)).toBe(true);
});

describe("IR kind sets", () => {
  test("keeps procStream as the scalar handle exception", () => {
    expect(HANDLE_KINDS.has("procStream")).toBe(true);
    expect(POINTER_KINDS.has("procStream")).toBe(false);
    for (const kind of HANDLE_KINDS) {
      if (kind !== "procStream") expect(POINTER_KINDS.has(kind)).toBe(true);
    }
  });

  test("distinguishes pointer values from object-like scalars", () => {
    expect(POINTER_KINDS.has("record")).toBe(true);
    expect(POINTER_KINDS.has("date")).toBe(false);
  });
});

describe("moduleUsesDynAsync", () => {
  test("does not gate the dynamic async runtime for a static promise", () => {
    expect(moduleUsesDynAsync(moduleWithExpr(ref({ kind: "promise", inner: F64 })))).toBe(false);
  });

  test("gates the dynamic async runtime when a typed promise converts to dyn", () => {
    const promise = ref({ kind: "promise", inner: F64 });
    const crossing: IrExpr = { kind: "dynFrom", value: promise, type: DYN, loc };
    expect(moduleUsesDynAsync(moduleWithExpr(crossing))).toBe(true);
  });

  test("gates for promise<dyn>, whose direct box also lives in the dynamic runtime", () => {
    const promise = ref({ kind: "promise", inner: DYN });
    const crossing: IrExpr = { kind: "dynFrom", value: promise, type: DYN, loc };
    expect(moduleUsesDynAsync(moduleWithExpr(crossing))).toBe(true);
  });

  test("finds a promise returned by a function that converts to dyn", () => {
    const callback = ref({
      kind: "func",
      params: [],
      ret: { kind: "promise", inner: F64 },
    });
    const crossing: IrExpr = { kind: "dynFrom", value: callback, type: DYN, loc };
    expect(moduleUsesDynAsync(moduleWithExpr(crossing))).toBe(true);
  });
});

describe("typed rest function ABI", () => {
  const rest: IrType = { kind: "func", params: [arrayOf(F64)], ret: VOID, rest: true, restAbi: "array" };
  const fixed = funcOf([arrayOf(F64)], VOID);
  const dynamic: IrType = { kind: "func", params: [], ret: VOID, rest: true };

  test("typed array, fixed array, and hidden dynamic rest signatures have distinct identities", () => {
    expect(new Set([rest, fixed, dynamic].map(typeKey)).size).toBe(3);
    expect(typeEquals(rest, fixed)).toBe(false);
    expect(typeEquals(rest, dynamic)).toBe(false);
    expect(typeEquals(rest, structuredClone(rest))).toBe(true);
  });

  test("unimplemented dynamic and engine adapters refuse typed rest closures", () => {
    expect(canBoxFuncIntoDyn(rest, () => undefined, () => undefined)).toBe(false);
    expect(canAdaptDynFuncTo(rest, () => undefined, () => undefined)).toBe(false);
    expect(canMarshalTypedFuncIntoIsland(rest, () => undefined, () => undefined)).toBe(false);
    expect(canBoxFuncIntoDyn(fixed, () => undefined, () => undefined)).toBe(true);
  });

  test("completed closure slots validate and survive serialization", () => {
    const mod = moduleWithExpr({ kind: "closure", fnName: "consume", captures: [], type: rest, loc });
    mod.functions.push({ name: "consume", params: [{ localId: "items", name: "items", type: arrayOf(F64) }],
      locals: [{ id: "items", name: "items", type: arrayOf(F64), mutable: false }], returnType: VOID, body: [], loc });
    expect(validateModule(mod)).toEqual([]);
    expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  });

  test("malformed typed rest signatures are rejected before emission", () => {
    const invalid: IrType[] = [{ ...rest, params: [] }, { ...rest, params: [F64] },
      { kind: "func", params: [arrayOf(F64)], ret: VOID, restAbi: "array" }];
    for (const type of invalid) {
      const mod = moduleWithExpr({ kind: "closure", fnName: "main", captures: [], type, loc });
      expect(validateModule(mod).map(e => e.message)).toContain(
        "in main: typed rest function requires a trailing array ABI slot");
    }
  });

  test("distinguishes full arguments from surplus rest closure ABIs", () => {
    const full = { kind: "func" as const, params: [STRING], ret: STRING, rest: true as const, argumentsAll: true as const };
    const surplus = { kind: "func" as const, params: [STRING], ret: STRING, rest: true as const };
    expect(typeEquals(full, surplus)).toBe(false);
    expect(typeKey(full)).toBe("func(string,arguments[])=>string");
  });
});
