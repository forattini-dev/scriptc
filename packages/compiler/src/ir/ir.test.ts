import { arrayOf, funcOf, typeKey, typeEquals, canBoxFuncIntoDyn, canAdaptDynFuncTo, canMarshalTypedFuncIntoIsland } from "./ir.js";
import { validateModule } from "./validate.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { describe, expect, test } from "vitest";
import {
  DYN,
  F64,
  HANDLE_KINDS,
  POINTER_KINDS,
  VOID,
  moduleUsesDynAsync,
  type IrExpr,
  type IrModule,
  type IrType,
} from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 1 };

function moduleWithExpr(expr: IrExpr): IrModule {
  return {
    irVersion: 6,
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
});
