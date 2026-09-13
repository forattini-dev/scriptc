import { expect, test } from "vitest";
import { BIGINT, VOID, type IrModule } from "../ir/ir.js";
import { emitCModule } from "./c/c-emitter.js";
import { emitLlvmModule } from "./llvm/emitter.js";
import { nativeModuleBackendDiagnostics } from "./native-module-support.js";

test("a BigInt global refuses C and LLVM before emitting source", () => {
  const mod: IrModule = {
    irVersion: 6, sourceFile: "bigint.ts", entry: "main",
    globals: [{ id: "large", name: "large", type: BIGINT, mutable: false }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID,
      body: [], loc: { file: "bigint.ts", start: 0, end: 1 } }],
  };
  expect(nativeModuleBackendDiagnostics(mod, "rust")).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(mod, backend)).toEqual([{
      code: "SC3001", loc: { file: "bigint.ts", start: 0, end: 0 },
      message: `the ${backend} backend does not support native BigInt values yet; use --backend rust`,
    }]);
  }
  expect(() => emitCModule(mod)).toThrow("native BigInt values");
  expect(() => emitLlvmModule(mod)).toThrow("native BigInt values");
});

test("refuses a BigInt kind test without any statically typed BigInt value", () => {
  const loc = { file: "unknown.ts", start: 1, end: 2 };
  const mod: IrModule = {
    irVersion: 6, sourceFile: "unknown.ts", entry: "main", globals: [],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID,
      body: [{ kind: "exprStmt", loc, expr: { kind: "dynTest", test: "bigint", type: { kind: "bool" }, loc,
        value: { kind: "libCall", fn: "json.parse", args: [{ kind: "strLit", value: "0", type: { kind: "string" }, loc }], type: { kind: "dyn" }, loc },
      } }], loc }],
  };
  expect(nativeModuleBackendDiagnostics(mod, "rust")).toEqual([]);
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(mod, backend)).toEqual([{
      code: "SC3001", loc,
      message: `the ${backend} backend does not support native BigInt values yet; use --backend rust`,
    }]);
  }
});
