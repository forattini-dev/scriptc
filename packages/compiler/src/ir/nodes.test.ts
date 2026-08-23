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
} from "./nodes.js";

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
