import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each(["test", "exec"])("Rust admits stateful %s while legacy backends keep an explicit refusal", (method) => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-regex-capability-"));
  try {
    const entry = join(root, "main.ts");
    writeFileSync(entry, `console.log(/a/g.${method}("a"));\n`);
    expect(analyze(entry, { backend: "rust", allowEngine: false }).coverage.diagnostics).toEqual([]);
    for (const backend of ["c", "llvm"] as const) {
      const diagnostics = analyze(entry, { backend }).coverage.diagnostics;
      expect(diagnostics.some(d => d.code === "SC1121" && d.message.includes(`'.${method}()'`))).toBe(true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
