import { expect, test } from "vitest";
import { VOID, type IrLibFn, type IrModule } from "../ir/ir.js";
import { LIB_FN_SIGS } from "../ir/validate.js";
import { evaluateLibraryFences, resolveLibraryFences } from "./fence-eval.js";

test.each<[string, IrLibFn]>([
  ["node-builtin.fs.openSync", "fs.openNumericSync"],
  ["node-builtin.crypto.randomFillSync", "crypto.randomFillRest"],
  ["node-builtin.crypto.randomBytes", "crypto.randomBytesCb"],
  ["node-builtin.process.exitCode", "process.setExitCode"],
  ["stdlib.date.parse", "date.parse"],
])("%s denies alternate IR spelling %s at its source location", (id, fn) => {
  const resolved = resolveLibraryFences([{ path: "fence", id, teaching: "use an explicit input" }]);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(resolved.detail);
  const loc = { file: "entry.ts", start: 21, end: 42 };
  // The fence walk consumes reached IR facts, independently of which backend
  // implements this overload. It must also work for imported/rebased bodies.
  const signature = LIB_FN_SIGS[fn];
  const mod: IrModule = { irVersion: 13, sourceFile: "entry.ts", entry: "main", functions: [{
    name: "main", params: [], locals: [], returnType: VOID, loc,
    body: [{ kind: "exprStmt", loc, expr: { kind: "libCall", fn, args: [], type: signature.result, loc } }],
  }] };
  const profile = { name: "deterministic", teachings: {}, fences: resolved.fences };
  const diagnostics = evaluateLibraryFences(mod, profile);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "SC4008", loc, note: "from the 'deterministic' profile: use an explicit input" });
  expect(diagnostics[0]!.message).toContain(id);
  mod.functions[0]!.body = [];
  expect(evaluateLibraryFences(mod, profile)).toEqual([]);
});
