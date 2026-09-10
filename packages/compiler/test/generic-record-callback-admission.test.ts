import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-generic-callback-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source + "\nexport {};\n");
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("generic callbacks retain distinct concrete scalar return signatures", () => {
  const coverage = coverageOf(`
type Spec = { kind: "value"; coerce: (raw: string) => unknown } | { kind: "boolean" };
function read<T extends Record<string, Spec>>(schema: T) {
  for (const [, spec] of Object.entries(schema)) {
    if (spec.kind !== "boolean") console.log(spec.coerce("2"));
  }
}
read({ flag: { kind: "boolean" }, number: { kind: "value", coerce: (raw: string) => Number(raw) },
  text: { kind: "value", coerce: (raw: string) => raw } });
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
});

test("generic callback dispatch refuses copying a composite return into unknown", () => {
  const coverage = coverageOf(`
type Spec = { kind: "value"; coerce: (raw: string) => unknown } | { kind: "boolean" };
function read<T extends Record<string, Spec>>(schema: T) {
  for (const [, spec] of Object.entries(schema)) {
    if (spec.kind !== "boolean") console.log(spec.coerce("2"));
  }
}
read({ flag: { kind: "boolean" }, value: { kind: "value", coerce: (raw: string) => ({ raw }) } });
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC1090", message: expect.stringContaining("spec.coerce") }),
  ]);
});

test("generic callback dispatch does not treat accessor slots as stored closures", () => {
  const coverage = coverageOf(`
type Spec = { kind: "value"; coerce: (raw: string) => unknown } | { kind: "boolean" };
function read<T extends Spec>(spec: T) {
  if (spec.kind !== "boolean") console.log(spec.coerce("2"));
}
function pick(flag: boolean): { kind: "boolean" } | { kind: "value"; get coerce(): (raw: string) => number } {
  return flag ? { kind: "boolean" } : { kind: "value", get coerce() { console.log("get"); return (raw: string) => Number(raw); } };
}
read(pick(false));
`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC1090", message: expect.stringContaining("spec.coerce") }),
  ]);
});
