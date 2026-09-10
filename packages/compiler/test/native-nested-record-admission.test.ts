import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const nested = `interface Leaf { aliases?: string[]; coerce: (raw: string) => unknown }
interface Outer { leaf: Leaf }
const source = { leaf: { aliases: ["n"], coerce: (raw: string) => raw } };
const boxed: unknown = source;
const view = boxed as Outer;
console.log(view.leaf.coerce("value")); export {};
`;

test("Rust admits checked nested callable records without an engine", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-nested-record-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, nested);
    const coverage = analyze(entry, { backend: "rust", allowEngine: false }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["c", "llvm"] as const)("%s rejects nested shared callable exits before creating output", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-nested-record-refusal-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, nested);
    const outDir = join(dir, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared callable record exits") }),
    ]);
    expect(existsSync(outDir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["c", "llvm"] as const)("%s keeps scalar callable exits supported", backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-callable-exit-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, 'const boxed: unknown = (n: number) => n + 1; const fn = boxed as (n: number) => number; console.log(fn(1)); export {};');
    const coverage = analyze(entry, { backend, allowEngine: false }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test.each(["c", "llvm"] as const)("%s rejects shared nested parameters in checked function adapters", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-nested-param-refusal-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, `interface Outer { leaf: { coerce: (raw: string) => number } }
const boxed: unknown = (value: Outer): number => value.leaf.coerce("1");
const fn = boxed as (value: Outer) => number;
console.log(fn({ leaf: { coerce: (raw: string) => Number(raw) } })); export {};
`);
    const outDir = join(dir, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared callable record exits") }),
    ]);
    expect(existsSync(outDir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
