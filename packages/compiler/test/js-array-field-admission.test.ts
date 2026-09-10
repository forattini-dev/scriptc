import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function coverageOf(source: string, extension = "js") {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-js-array-fields-"));
  try {
    const entry = join(dir, `main.${extension}`);
    writeFileSync(entry, source + "\nexport {};\n");
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("JS factory array fields admit their later string elements", () => {
  const coverage = coverageOf(`
function create() {
  const result = { errors: [], rest: [] };
  result.errors.push("bad"); result.rest.push("tail");
  return result;
}
const result = create(); console.log(result.errors[0], result.rest[0]);
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.runtimeFences ?? []).toEqual([]);
});

test.each(["js", "ts"])("%s array element declarations are not weakened by empty initializers", extension => {
  const declaration = extension === "js" ?
    '/** @type {{ values: number[] }} */ const result = { values: [] };' :
    'const result: { values: number[] } = { values: [] };';
  const coverage = coverageOf('function create() {\n' + declaration + '\nresult.values.push("wrong"); return result; } create();', extension);
  expect(coverage.diagnostics.length).toBeGreaterThan(0);
  expect(coverage.diagnostics.some(d => d.message.includes("number") && d.message.includes("string"))).toBe(true);
});

test.each(["js", "ts"])("%s declared string fields accept strings", extension => {
  const declaration = extension === "js" ?
    '/** @type {{ values: string[] }} */ const result = { values: [] };' :
    'const result: { values: string[] } = { values: [] };';
  const coverage = coverageOf('function create() {\n' + declaration + '\nresult.values.push("ok"); return result; } console.log(create().values[0]);', extension);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.runtimeFences ?? []).toEqual([]);
});

test.each(["c", "llvm"] as const)("%s refuses shared arrays mixed with unknown fields before binary emission", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-container-field-refusal-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, 'const value: unknown = { values: [] }; const result = value as { values: string[]; metadata: unknown }; console.log(result.values.length); export {};');
    const outDir = join(dir, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("record exits with unknown fields") }),
    ]);
    expect(existsSync(outDir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
