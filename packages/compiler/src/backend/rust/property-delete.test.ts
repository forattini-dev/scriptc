import { expect, test } from "vitest";
import { BOOL, DYN, F64, MAY_THROW_LIB_FNS, STRING, VOID, type IrExpr, type IrModule } from "../../ir/ir.js";
import { serializeModule, deserializeModule } from "../../ir/serialize.js";
import { validateModule } from "../../ir/validate.js";
import { nativeModuleBackendDiagnostics } from "../native-module-support.js";
import { emitRustModule } from "./emitter.js";
import { rustEngineRequirement } from "./runtime-features.js";

const loc = { file: "delete.ts", start: 0, end: 1 };
function module(): { mod: IrModule; operation: IrExpr & { kind: "libCall" } } {
  const operation: IrExpr & { kind: "libCall" } = { kind: "libCall", fn: "dyn.keyDelete", args: [
    { kind: "dynObjLit", fields: [], type: DYN, loc },
    { kind: "strLit", value: "key", type: STRING, loc },
    { kind: "boolLit", value: true, type: BOOL, loc },
  ], type: BOOL, loc };
  return { operation, mod: { irVersion: 13, sourceFile: loc.file, entry: "main", functions: [
    { name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr: operation, loc }], loc },
  ] } };
}

test("native deletion validates, round trips and retains a throwing Boolean contract", () => {
  const { mod, operation } = module();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  expect(MAY_THROW_LIB_FNS.has("dyn.keyDelete")).toBe(true);
  operation.type = VOID;
  expect(validateModule(mod).length).toBeGreaterThan(0);
  operation.type = BOOL;
  operation.args[2] = { kind: "numLit", value: 1, type: F64, loc };
  expect(validateModule(mod).length).toBeGreaterThan(0);
  operation.args.pop();
  expect(validateModule(mod).length).toBeGreaterThan(0);
});

test("native deletion emits the Rust property protocol without an engine and refuses C/LLVM", () => {
  const { mod } = module();
  expect(rustEngineRequirement(mod)).toBeNull();
  const rust = emitRustModule(mod);
  expect(rust).toContain("impl runtime::NativeDeleteValue");
  expect(rust).toContain("runtime::native_delete_property");
  expect(nativeModuleBackendDiagnostics(mod, "rust")).toEqual([]);
  expect(nativeModuleBackendDiagnostics(mod, "c")).toHaveLength(1);
  expect(nativeModuleBackendDiagnostics(mod, "llvm")).toHaveLength(1);
});
