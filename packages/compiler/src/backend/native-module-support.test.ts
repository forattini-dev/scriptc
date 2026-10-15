import { expect, test } from "vitest";
import { type IrExpr, type IrModule, DYN, STRING, JSVAL, VOID } from "../ir/ir.js";
import { validateModule } from "../ir/validate.js";
import { emitModule } from "./c/c-emitter.js";
import { emitLlvmModule } from "./llvm/emitter.js";
import { emitRustModule } from "./rust/emitter.js";
import { rustEngineRequirement } from "./rust/runtime-features.js";
import { nativeModuleBackendDiagnostics } from "./native-module-support.js";

const loc = { file: "native-module.ts", start: 2, end: 4 };
const mod: IrModule = {
  irVersion: 13, sourceFile: loc.file, entry: "%init",
  globals: [{ id: "%g.cache", name: "cache", type: { kind: "promise", inner: VOID }, mutable: true }],
  functions: [{ name: "%init", params: [], locals: [], returnType: VOID,
    syncModuleCacheGlobal: "%g.cache", body: [], loc }],
};

test("function arity metadata emits natively in Rust and stays fenced in C/LLVM", () => {
  const boxed: IrExpr = { kind: "dynFrom", fnLength: 0, type: DYN, loc,
    value: { kind: "closure", fnName: "target", captures: [], type: { kind: "func", params: [STRING], ret: VOID }, loc } };
  const module: IrModule = { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [
    { name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr: boxed, loc }], loc },
    { name: "target", params: [{ localId: "arg", name: "arg", type: STRING }], locals: [{ id: "arg", name: "arg", type: STRING, mutable: true }], returnType: VOID, body: [], loc },
  ] };
  expect(validateModule(module)).toEqual([]);
  expect(rustEngineRequirement(module)).toBeNull();
  expect(emitRustModule(module)).toContain("sc_dyn_function_with_length(");
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(module, backend)).toContainEqual(expect.objectContaining({ code: "SC3001", message: expect.stringContaining("function arity metadata") }));
  }
  expect(() => emitModule(module)).toThrow("function arity metadata");
  expect(() => emitLlvmModule(module)).toThrow("function arity metadata");
});

test("C and LLVM refuse module evaluation cache metadata rather than ignoring it", () => {
  expect(validateModule(mod)).toEqual([]);
  expect(nativeModuleBackendDiagnostics(mod, "rust")).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(mod, backend)).toEqual([{
      code: "SC3001", loc,
      message: `the ${backend} backend does not support native local module imports yet; use --backend rust`,
    }]);
  }
  expect(() => emitModule(mod)).toThrow("use --backend rust");
  expect(() => emitLlvmModule(mod)).toThrow("use --backend rust");
  const rust = emitRustModule(mod);
  expect(rust).toContain("runtime::module_evaluate_sync(&sc_evaluation");
  expect(rust).toContain("runtime::module_cached_sync(&sc_cached)");
});

test("native namespace operations require a namespace value and refuse C/LLVM", () => {
  const object: IrExpr = { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc };
  const namespace: IrExpr = { kind: "libCall", fn: "module.namespace", args: [object], type: JSVAL, loc };
  const module: IrModule = { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [{
    name: "main", params: [], locals: [], returnType: VOID,
    body: [{ kind: "exprStmt", expr: namespace, loc }], loc,
  }] };
  expect(validateModule(module)).toEqual([]);
  expect(nativeModuleBackendDiagnostics(module, "c")).toHaveLength(1);
  expect(nativeModuleBackendDiagnostics(module, "llvm")).toHaveLength(1);
  expect(nativeModuleBackendDiagnostics(module, "rust")).toEqual([]);
  expect(emitRustModule(module)).toContain("runtime::map_mark_module_namespace");
});

test("native imports validate a loader promise and emit without an engine global", () => {
  const imported: IrExpr = { kind: "libCall", fn: "module.import", args: [{
    kind: "closure", fnName: "load", captures: [],
    type: { kind: "func", params: [], ret: { kind: "promise", inner: JSVAL } }, loc,
  }], type: { kind: "promise", inner: JSVAL }, loc };
  const module: IrModule = {
    irVersion: 13, sourceFile: loc.file, entry: "main", functions: [{
      name: "main", params: [], locals: [], returnType: VOID,
      body: [{ kind: "exprStmt", expr: imported, loc }], loc,
    }, {
      name: "load", params: [], locals: [], captures: [], async: true, returnType: JSVAL,
      body: [{ kind: "return", value: { kind: "jsOp", op: "objLit", args: [], type: JSVAL, loc }, loc }], loc,
    }],
  };
  expect(validateModule(module)).toEqual([]);
  expect(rustEngineRequirement(module)).toBeNull();
  expect(emitRustModule(module)).toContain("runtime::module_import(move ||");
  imported.args = [];
  expect(validateModule(module).map((error) => error.message)).toContainEqual(expect.stringContaining("module.import"));
});
