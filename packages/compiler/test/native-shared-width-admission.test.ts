import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

function source(extra: string): string {
  return `
function read<T>(service: T, key: string): unknown { return service[key as keyof T]; }
const full = { read: () => 1, label: "service", extra: ${extra} };
const narrow: { read: () => number; label: string } = full;
console.log(read(narrow, "extra"));
`;
}

test.each([
  ["Map", "new Map<string, number>()"],
  ["Uint32Array", "new Uint32Array([7])"],
  ["record array", "[{ count: 7 }]"],
])("Rust refuses a shared width view that would discard an extra %s", async (_label, extra) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-shared-width-refusal-"));
  try {
    const entry = join(directory, "main.ts");
    const outPath = join(directory, "program.rs");
    writeFileSync(entry, source(extra));
    const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory, outPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared record projection from an unsupported source layout") }),
    ]);
    expect(existsSync(outPath)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Rust admits a width view whose source preserves every extra field", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-shared-width-admission-"));
  try {
    const entry = join(directory, "main.ts");
    const outPath = join(directory, "program.rs");
    writeFileSync(entry, source("7"));
    const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory, outPath });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toMatchObject({ kind: "rust", path: outPath });
    expect(existsSync(outPath)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
