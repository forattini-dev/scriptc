import { expect, test } from "vitest";
import { BOOL, DYN, REGEX, STRING, VOID, MAY_THROW_LIB_FNS, type IrExpr, type IrModule } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { nativeModuleBackendDiagnostics } from "../native-module-support.js";
import { emitRustModule } from "./emitter.js";
import { rustEngineRequirement } from "./runtime-features.js";

const loc = { file: "replacement.ts", start: 0, end: 1 };
const operation: IrExpr = { kind: "libCall", fn: "regex.replaceCaptures", args: [
  { kind: "strLit", value: "a", type: STRING, loc },
  { kind: "regexLit", pattern: "(a)", flags: "g", type: REGEX, loc },
  { kind: "dynObjLit", fields: [], type: DYN, loc },
  { kind: "boolLit", value: false, type: BOOL, loc },
], type: STRING, loc };
const moduleFor = (expr: IrExpr): IrModule => ({ irVersion: 13, sourceFile: loc.file, entry: "main", functions: [
  { name: "main", params: [], locals: [], returnType: VOID, body: [{ kind: "exprStmt", expr, loc }], loc },
] });

test("replacement capture ABI validates and uses compiled dynamic calls without an engine", () => {
  const module = moduleFor(operation);
  expect(validateModule(module)).toEqual([]);
  expect(MAY_THROW_LIB_FNS.has("regex.replaceCaptures")).toBe(true);
  expect(rustEngineRequirement(module)).toBeNull();
  const rust = emitRustModule(module);
  expect(rust).toContain("runtime::regex_replace_captures");
  expect(rust).toContain("sc_dyn_call(&");
  expect(rust).toContain("matched.captures.into_iter()");
  expect(rust).toContain("sc_dyn_mark_null_proto(&object)");
  expect(rust).toContain("sc_dyn_this_push(");
  for (const backend of ["c", "llvm"] as const) {
    expect(nativeModuleBackendDiagnostics(module, backend)).toContainEqual(expect.objectContaining({
      code: "SC3001", message: expect.stringContaining("native regex replacement callback"),
    }));
  }
});

test("replacement capture ABI rejects wrong arity, flags, callback storage and result", () => {
  if (operation.kind !== "libCall") throw new Error("fixture");
  for (const invalid of [
    { ...operation, args: operation.args.slice(0, 3) },
    { ...operation, args: [...operation.args.slice(0, 3), operation.args[0]!] },
    { ...operation, args: [operation.args[0]!, operation.args[1]!, operation.args[0]!, operation.args[3]!] },
    { ...operation, type: VOID },
  ]) expect(validateModule(moduleFor(invalid))).not.toEqual([]);
});
