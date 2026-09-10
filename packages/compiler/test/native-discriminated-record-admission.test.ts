import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const schema = `type Flag = { kind: "boolean" } | { kind: "value"; coerce: (raw: string) => unknown };
const value = { kind: "value" as const, coerce: (raw: string) => Number(raw) };
const source = { number: value };
function accept(schema: Record<string, Flag>) { return schema; }
const view = accept(source);
console.log(view.number.kind); export {};
`;

function fixture(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-discriminated-record-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  return { dir, entry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Rust admits fixed flag schemas and optional discriminated views without an engine", () => {
  const f = fixture(schema + `
function optional(flag: Flag | undefined = value): Flag | undefined { return flag; }
console.log(optional() === undefined);
`);
  try {
    const coverage = analyze(f.entry, { backend: "rust", allowEngine: false }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { f.cleanup(); }
});

test.each(["c", "llvm"] as const)("%s rejects shared callable schema conversion before output", async backend => {
  const f = fixture(schema);
  try {
    const outDir = join(f.dir, "out");
    const result = await compile(f.entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared callable record exits") }),
    ]);
    expect(existsSync(outDir)).toBe(false);
  } finally { f.cleanup(); }
});

test.each(["c", "llvm"] as const)("%s rejects dynamic dictionaries of callable records before output", async backend => {
  const f = fixture(`type Flag = { coerce: (raw: string) => number }; const source: unknown = { one: { coerce: (raw: string) => Number(raw) } }; const view = source as Record<string, Flag>; console.log(view.one.coerce("1")); export {};`);
  try {
    const outDir = join(f.dir, "out");
    const result = await compile(f.entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.message).toContain("shared callable record exits");
    expect(existsSync(outDir)).toBe(false);
  } finally { f.cleanup(); }
});
