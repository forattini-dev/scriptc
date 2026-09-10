import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const scalar = `type Entry = { kind: "number"; count: number } | { kind: "label"; text: string };
const source = { count: { kind: "number" as const, count: 1 }, label: { kind: "label" as const, text: "a" } };
function read<S extends Record<string, Entry>>(schema: S, name: string): Entry | undefined { return schema[name]; }
console.log(read(source, "count") === read(source, "count")); export {};`;

test("Rust admits heterogeneous keyed record views without losing missing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-schema-key-"));
  try {
    const entry = join(dir, "main.ts"); writeFileSync(entry, scalar);
    const coverage = analyze(entry, { backend: "rust", allowEngine: false }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["c", "llvm"] as const)("%s refuses shared heterogeneous scalar-record reads before output", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-schema-key-refusal-"));
  try {
    const entry = join(dir, "main.ts"); writeFileSync(entry, scalar);
    const outDir = join(dir, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared heterogeneous record keyed reads") })]);
    expect(existsSync(outDir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
