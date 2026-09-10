import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function coverageOf(member: string, source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-native-factory-admission-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, `import { create } from "./source.js"; interface Api { ${member} } const api: Api = create(); console.log(typeof api);`);
    writeFileSync(join(dir, "source.js"), source);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("an inferred JS factory enters its declared scalar method interface", () => {
  const coverage = coverageOf("push(value: number): number", "export function create() { return { push(value) { return value + 1; } }; }");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
});

test("factory method array parameters use shared storage", () => {
  const coverage = coverageOf("push(values: number[]): number", "export function create() { return { push(values) { return values.length; } }; }");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
});

test("factory methods using this retain their existing explicit refusal", () => {
  const coverage = coverageOf("value: number; read(): number", "export function create() { return { value: 1, read() { return this.value; } }; }");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.runtimeFences?.some(fence => fence.message.includes("references to 'this'"))).toBe(true);
});


test.each(["c", "llvm"] as const)("%s refuses a shared callable exit before writing a binary", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-native-factory-backend-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, 'import { create } from "./source.js"; interface Api { read(): number } const api: Api = create(); console.log(api.read());');
    writeFileSync(join(dir, "source.js"), 'export function create() { return { read() { return 1; } }; }');
    const expected = expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared callable record exits") });
    expect(analyze(entry, { backend, allowEngine: false }).coverage.diagnostics).toEqual([expected]);
    const outDir = join(dir, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([expected]);
    expect(existsSync(outDir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("factory method scalar record parameters use shared indexed storage", () => {
  const coverage = coverageOf("push(values: Record<string, number>): number", "export function create() { return { push(values) { return values.count; } }; }");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
});

// Corpus 3145 checks native execution, nested aliases and retained mutations.
test("factory method nested record parameters use shared indexed storage", () => {
  const coverage = coverageOf("push(values: Record<string, { count: number }>): number", "export function create() { return { push(values) { return values.item.count; } }; }");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
});

test.each(["c", "llvm"] as const)("%s refuses a newly shared indexed record cast", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-native-indexed-cast-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, 'const source: Record<string, unknown> = { value: 1 }; const numbers = source as Record<string, number>; console.log(numbers.value);');
    const outDir = join(dir, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared indexed record casts") })]);
    expect(existsSync(outDir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
