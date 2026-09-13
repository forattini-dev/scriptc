import { expect, test } from "vitest";
import { DYN, F64, STRING, VOID, type IrExpr, type IrModule, type IrType } from "./ir.js";
import { validateModule } from "./validate.js";
import { serializeModule, deserializeModule } from "./serialize.js";
import { nativeModuleBackendDiagnostics } from "../backend/native-module-support.js";

const loc = { file: "promise-view.ts", start: 0, end: 1 };
const source: IrType = { kind: "promise", inner: F64 };
const target: IrType = { kind: "promise", inner: DYN };
const sourceValue: IrExpr = { kind: "varRef", localId: "source", type: source, loc };
const converter: IrExpr = { kind: "closure", fnName: "convert", captures: [], type: { kind: "func", params: [F64], ret: DYN }, loc };
const view: Extract<IrExpr, { kind: "libCall" }> = { kind: "libCall", fn: "promise.view", args: [
  sourceValue, converter,
], type: target, loc };

function moduleWith(expr: IrExpr): IrModule {
  return { irVersion: 6, sourceFile: loc.file, entry: "main", functions: [
    { name: "main", params: [], locals: [], returnType: VOID, body: [], loc },
    { name: "bridge", params: [{ localId: "source", name: "source", type: source }],
      locals: [{ id: "source", name: "source", type: source, mutable: false }], returnType: target,
      body: [{ kind: "return", value: expr, loc }], loc },
    { name: "convert", params: [{ localId: "payload", name: "payload", type: F64 }],
      locals: [{ id: "payload", name: "payload", type: F64, mutable: false }], returnType: DYN,
      body: [{ kind: "return", value: { kind: "dynFrom", value: { kind: "varRef", localId: "payload", type: F64, loc }, type: DYN, loc }, loc }], loc },
  ] };
}

test("serialized Promise payload views validate and retain explicit legacy backend refusals", () => {
  const module = deserializeModule(serializeModule(moduleWith(view)));
  expect(validateModule(module)).toEqual([]);
  expect(nativeModuleBackendDiagnostics(module, "rust")).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(module, backend)).toEqual([{ code: "SC3001", loc,
      message: `the ${backend} backend does not support Promise payload views yet; use --backend rust` }]);
  }
});

test("invalid Promise payload conversions fail validation before Rust emission", () => {
  for (const expr of [
    { ...view, args: [] },
    { ...view, type: { kind: "promise", inner: STRING } as IrType },
    { ...view, args: [sourceValue, { ...converter, captures: ["source"] }] },
  ]) {
    expect(validateModule(moduleWith(expr)).some(error => error.message.includes("promise.view"))).toBe(true);
  }
});
