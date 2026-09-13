import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test.each(["c", "llvm", "rust"] as const)("%s retains String conversions over ordinary dynamic values", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-string-constructor-"));
  const entry = join(dir, "main.ts");
  try {
    writeFileSync(entry, `function text(value: unknown): string { return String(value); }
console.log(text(7), text('word'), text(true)); export {};\n`);
    const result = await compile(entry, { backend, allowEngine: false, outputKind: backend, outDir: dir, outPath: join(dir, "program.source") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
