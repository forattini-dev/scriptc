import { expect, test } from "vitest";
import { BOOL, DYN, F64, VOID, canDynCheckTo, type IrExpr, type IrModule, type IrType } from "./ir.js";
import { validateModule } from "./validate.js";

test("owning class handles survive callback and optional-slot checked extraction", () => {
  const box: IrType = { kind: "object", className: "Box" };
  const callback: IrType = { kind: "func", params: [], ret: box };
  const unions = new Map([
    ["u0", { id: "u0", arms: [box, { kind: "undefinedT" } as IrType] }],
    ["u1", { id: "u1", arms: [callback, { kind: "undefinedT" } as IrType] }],
  ]);
  for (const type of [box, callback, { kind: "union", unionId: "u0" }, { kind: "union", unionId: "u1" }] as IrType[]) {
    expect(canDynCheckTo(type, () => undefined, id => unions.get(id))).toBe(true);
  }
  const loc = { file: "private-slot.ts", start: 0, end: 0 };
  const input: IrExpr = { kind: "dynObjLit", fields: [], type: DYN, loc };
  const mod: IrModule = {
    irVersion: 13, sourceFile: loc.file, entry: "main",
    classes: [{ name: "Box", jsName: "Box", fields: [], loc }],
    unions: [...unions.values()],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, loc,
      body: [...unions.keys()].map(unionId => ({ kind: "exprStmt", expr: { kind: "dynCheck", value: input, type: { kind: "union", unionId }, loc }, loc })),
    }],
  };
  expect(validateModule(mod)).toEqual([]);
});

test("caught tests and trusted extraction admit standalone classes and reject unknown classes", () => {
  const loc = { file: "classes.ts", start: 0, end: 0 };
  const caught: IrExpr = { kind: "varRef", localId: "e", type: { kind: "caught" }, loc };
  const check: IrExpr = { kind: "caughtTest", value: caught, test: "instanceof", className: "Box", type: BOOL, loc };
  const narrow: IrExpr = { kind: "caughtNarrow", value: caught, type: { kind: "object", className: "Box" }, loc };
  const mod: IrModule = {
    irVersion: 13, sourceFile: loc.file, entry: "main",
    classes: [{ name: "Box", jsName: "Box", fields: [], loc }],
    functions: [{
      name: "main", params: [], locals: [{ id: "e", name: "e", type: { kind: "caught" }, mutable: false }], returnType: VOID,
      body: [{ kind: "tryCatch", tryBody: [{ kind: "throw", value: { kind: "numLit", value: 1, type: F64, loc }, loc }], catchLocalId: "e", catchBody: [{ kind: "exprStmt", expr: check, loc }, { kind: "exprStmt", expr: narrow, loc }], finallyBody: null, loc }],
      loc,
    }],
  };
  expect(validateModule(mod)).toEqual([]);
  check.className = "Missing";
  expect(validateModule(mod).some(error => error.message.includes("caughtTest instanceof against unknown class"))).toBe(true);
  check.className = "Box";
  narrow.type = { kind: "object", className: "Missing" };
  expect(validateModule(mod).some(error => error.message.includes("caughtNarrow to unknown class"))).toBe(true);
});
