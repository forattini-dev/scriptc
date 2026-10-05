import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { validateModule } from "../../ir/validate.js";
import { loadProgram } from "../program.js";
import { lowerToIr } from "./lowerer.js";

test("computed assignment captures its reference and shares one dynamic result with the write", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-computed-assignment-ir-"));
  try {
    const entry = join(directory, "main.mjs");
    writeFileSync(entry, 'function write(object, key, value) { return (object[key] = value); } console.log(write({}, "key", 1));');
    const load = loadProgram(entry);
    try {
      const result = lowerToIr(load.program, load.entry, load.moduleOrder, { nativeDenseArrays: true });
      expect(result.diagnostics).toEqual([]);
      expect(result.runtimeFences).toEqual([]);
      if (!result.module) throw new Error("expected a lowered module");
      expect(validateModule(result.module)).toEqual([]);
      const fn = result.module.functions.find(fn => fn.name === "write");
      const returned = fn?.body.find(statement => statement.kind === "return");
      if (returned?.kind !== "return" || returned.value?.kind !== "seqExpr") throw new Error("expected a sequenced assignment return");
      const expr = returned.value;
      expect(expr.type).toEqual({ kind: "dyn" });
      expect(expr.stmts.map(statement => statement.kind)).toEqual(["varDecl", "varDecl", "varDecl", "exprStmt"]);
      const write = expr.stmts[3];
      if (write?.kind !== "exprStmt" || write.expr.kind !== "libCall") throw new Error("expected a dynamic write");
      expect(write.expr.fn).toBe("dyn.keySetComputed");
      expect(write.expr.args[2]).toBe(expr.result);
      expect(write.expr.args.map(arg => arg.type.kind)).toEqual(["dyn", "dyn", "dyn"]);
    } finally { load.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
