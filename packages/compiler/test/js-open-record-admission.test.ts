import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function coverageOf(source: string, extension: "ts" | "js") {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-js-open-record-"));
  try {
    const entry = join(dir, `main.${extension}`);
    writeFileSync(entry, source + "\nexport {};\n");
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("inferred JS empty fields support indexed writes through their original alias", () => {
  const coverage = coverageOf(`
const result = { options: {} };
const alias = result.options;
const key = "count";
alias[key] = 2;
console.log(result.options[key], alias === result.options);
`, "js");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.runtimeFences ?? []).toEqual([]);
});

test("TS generic empty literals retain their closed record admission", () => {
  const coverage = coverageOf(`
function read<T extends Record<string, unknown>>(value: T) {
  const key: string = "count";
  console.log(value[key]);
}
read({});
`, "ts");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC1090", message: expect.stringContaining("dynamic keyed reads of '{}'") }),
  ]);
});

test.each(["c", "llvm"] as const)("%s refuses shared open-record operations before binary emission", async backend => {
  const cases = [
    { extension: "js", source: 'const result = { options: {} }; console.log(delete result.options["count"]);', reason: "dictionary deletion" },
    { extension: "ts", source: 'const value: unknown = { field: 1 }; const row = value as { field: unknown }; console.log(row.field);', reason: "record exits with unknown fields" },
    { extension: "ts", source: 'const row: Record<string, unknown> = {}; const value: unknown = row; console.log(row === value);', reason: "record identity comparisons" },
  ];
  for (const { extension, source, reason } of cases) {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-open-record-refusal-"));
    try {
      const entry = join(dir, `main.${extension}`);
      writeFileSync(entry, source + "\nexport {};\n");
      const outDir = join(dir, "out");
      const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "SC3001", message: expect.stringContaining(reason) }),
      ]);
      expect(existsSync(outDir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
