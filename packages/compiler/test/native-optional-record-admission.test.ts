import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const source = `interface Flag { aliases?: string[]; coerce: (raw: string) => number | undefined }
const flag: Flag = { aliases: ["n"], coerce: (raw: string): number | undefined => raw === "none" ? undefined : Number(raw) };
const boxed: unknown = flag;
`;

test("native optional fields and scalar-union callbacks admit a shared checked view", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-optional-record-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source + 'const view = boxed as Flag; console.log(view.coerce("42")); export {};');
    const coverage = analyze(entry, { backend: "rust", allowEngine: false }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["c", "llvm"] as const)("%s refuses shared checked optional callable views", async backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-optional-record-refusal-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source + 'const view = boxed as Flag; console.log(view.coerce("42")); export {};');
    const outDir = join(dir, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("callable record exits") }),
    ]);
    expect(existsSync(outDir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test.each(["c", "llvm"] as const)("%s retains existing optional callable record boxing", backend => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-optional-record-box-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source + 'console.log(typeof boxed); export {};');
    const coverage = analyze(entry, { backend, allowEngine: false }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("native imports retain their nested callable parameter refusal", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-import-optional-record-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(join(dir, "module.ts"), `interface Options { aliases?: string[]; coerce: (raw: string) => number | undefined }
export async function run(options: Options): Promise<void> { console.log(options.coerce("42")); }
`);
    writeFileSync(entry, 'const module = await import("./module.js"); console.log(typeof module.run); export {};');
    const coverage = analyze(entry, { backend: "rust", allowEngine: false }).coverage;
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC1090", message: expect.stringContaining("outside native callback admission") }),
    ]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
