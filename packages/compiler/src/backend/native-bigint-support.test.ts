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
