import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-object-iteration-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source + "\nexport {};\n");
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("object union entries retain values from disjoint field names", () => {
  const coverage = coverageOf(`
function show(value: { count: number } | { name: string }) {
  for (const [key, entry] of Object.entries(value)) {
    console.log(key, typeof entry === "string" ? entry.toUpperCase() : entry + 1);
  }
}
show({ count: 1 }); show({ name: "a" });
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
});

test.each(["entries", "values"])("Object.%s admits optional hybrid records with an empty fallback", member => {
  const coverage = coverageOf(`
interface Event { kind: string; count?: number; [key: string]: unknown }
function show(event?: Event) { console.log(Object.${member}(event ?? {}).length); }
show({ kind: "test", extra: null }); show();
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
});

test("object union iteration keeps the accessor fence", () => {
  const coverage = coverageOf(`
function show(value: { get name(): string } | { count: number }) {
  console.log(Object.entries(value).length);
}
show({ get name() { return "a"; } });
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC1090", message: expect.stringContaining("accessor properties") }),
  ]);
});

test("heterogeneous object entries refuse a composite copy into an unknown result", () => {
  const coverage = coverageOf(`
function show(value: { child: { count: number } } | { opaque: unknown }) {
  console.log(Object.entries(value).length);
}
show({ child: { count: 1 } });
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC1090", message: expect.stringContaining("field 'child'") }),
  ]);
});
