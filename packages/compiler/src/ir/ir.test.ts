import { arrayOf, funcOf, typeKey, typeEquals, canBoxFuncIntoDyn, canAdaptDynFuncTo, canConvertToDyn, canMarshalTypedFuncIntoIsland } from "./ir.js";
import { validateModule } from "./validate.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { describe, expect, test } from "vitest";
import {
  DYN,
  BOOL,
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
    irVersion: 13,
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

test("symbol copy validates and round-trips both owning operands", () => {
  const object: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const copy: IrExpr = { kind: "libCall", fn: "dyn.copyEnumerableSymbols", args: [object, object], type: VOID, loc };
  const module = moduleWithExpr(copy);
  expect(validateModule(module)).toEqual([]);
  expect(moduleHasLibCall(module, "dyn.copyEnumerableSymbols")).toBe(true);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
});

test("symbol presence validates and round-trips both dynamic operands", () => {
  const object: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const check: IrExpr = { kind: "libCall", fn: "dyn.hasSymbolKey", args: [object, object], type: BOOL, loc };
  const module = moduleWithExpr(check);
  expect(validateModule(module)).toEqual([]);
  expect(moduleHasLibCall(module, "dyn.hasSymbolKey")).toBe(true);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
});

test("dynamic ordinary data descriptors validate and round-trip their three operands", () => {
  const object: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const define: IrExpr = { kind: "libCall", fn: "dyn.defineOrdinaryData", args: [object, object, object], type: DYN, loc };
  const module = moduleWithExpr(define);
  expect(validateModule(module)).toEqual([]);
  expect(moduleHasLibCall(module, "dyn.defineOrdinaryData")).toBe(true);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
  expect(validateModule(moduleWithExpr({ ...define, args: [object, object] })).length).toBeGreaterThan(0);
});

test("callable views require the record's exact function signature", () => {
  const signature = funcOf([], VOID);
  const record: IrType = { kind: "record", shapeId: "callable" };
  const closure: IrExpr = { kind: "closure", fnName: "target", captures: [], type: signature, loc };
  const view: IrExpr = { kind: "libCall", fn: "callable.view", args: [closure], type: record, loc };
  const module = moduleWithExpr(view);
  module.records = [{ id: "callable", fields: [{ name: "\0scriptc.call", type: signature }] }];
  module.functions.push({ name: "target", params: [], locals: [], returnType: VOID, body: [], loc });
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
  module.records[0]!.fields[0]!.type = STRING;
  expect(validateModule(module).some(error => error.message.includes("callable.view"))).toBe(true);
});

test("native await wire representation validates only inside async functions", () => {
  const promise: IrType = { kind: "promise", inner: F64 };
  const value: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
  const resolved: IrExpr = { kind: "intrinsic", name: "promise.resolve", args: [value], type: promise, loc };
  const awaited: IrExpr = { kind: "awaitExpr", value: resolved, type: F64, loc };
  const module = moduleWithExpr(value);
  module.functions.push({ name: "suspended", async: true, params: [], locals: [], returnType: F64, body: [{ kind: "return", value: awaited, loc }], loc });
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
  delete module.functions[1]!.async;
  expect(validateModule(module).some(error => error.message.includes("await outside"))).toBe(true);
});

test("computed deletion validates key and strictness operands", () => {
  const object: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const strict: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
  const remove: IrExpr = { kind: "libCall", fn: "dyn.keyDeleteComputed", args: [object, object, strict], type: BOOL, loc };
  const module = moduleWithExpr(remove);
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
  expect(validateModule(moduleWithExpr({ ...remove, args: [object, strict, strict] })).length).toBeGreaterThan(0);
});

test("immediate Map key materialization preserves the key array type", () => {
  const mapType: IrType = { kind: "map", key: STRING, value: F64 };
  const map: IrExpr = { kind: "mapNew", seed: [], type: mapType, loc };
  const keys: IrExpr = { kind: "mapIntrinsic", method: "keysToArray", receiver: map, args: [], type: arrayOf(STRING), loc };
  const module = moduleWithExpr(keys);
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
  expect(validateModule(moduleWithExpr({ ...keys, type: arrayOf(F64) })).length).toBeGreaterThan(0);
});

test("dynamic immediate Map keys use an owning array of dynamic keys", () => {
  const object: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const keys: IrExpr = { kind: "libCall", fn: "dyn.mapKeysImmediate", args: [object], type: arrayOf(DYN), loc };
  const module = moduleWithExpr(keys);
  expect(validateModule(module)).toEqual([]);
  expect(validateModule(deserializeModule(serializeModule(module)))).toEqual([]);
  expect(validateModule(moduleWithExpr({ ...keys, type: arrayOf(STRING) })).length).toBeGreaterThan(0);
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

  test("native dynamic adapters accept typed rest while engine adapters remain fenced", () => {
    expect(canBoxFuncIntoDyn(rest, () => undefined, () => undefined)).toBe(true);
    expect(canAdaptDynFuncTo(rest, () => undefined, () => undefined)).toBe(true);
    expect(canMarshalTypedFuncIntoIsland(rest, () => undefined, () => undefined)).toBe(false);
    expect(canBoxFuncIntoDyn(fixed, () => undefined, () => undefined)).toBe(true);
  });

  test("dynamic rest adapters require a real typed array slot", () => {
    for (const type of [{ ...rest, params: [] }, { ...rest, params: [F64] }]) {
      expect(canBoxFuncIntoDyn(type, () => undefined, () => undefined)).toBe(false);
      expect(canAdaptDynFuncTo(type, () => undefined, () => undefined)).toBe(false);
    }
    expect(canAdaptDynFuncTo(dynamic, () => undefined, () => undefined)).toBe(false);
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
