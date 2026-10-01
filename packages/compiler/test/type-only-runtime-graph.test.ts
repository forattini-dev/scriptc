import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function coverageOf(entrySource: string, librarySource?: string, target: "node24" | "bun" = "node24") {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-type-only-graph-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "ambient.d.ts"), 'declare module "missing-type-graph-runtime" {} declare module "node:inspector" {}');
    writeFileSync(join(dir, "library.ts"), '/// <reference path="./ambient.d.ts" />\n' + (librarySource ?? `
import "missing-type-graph-runtime";
export interface Shape { label: string }
export const value = 7;
`));
    writeFileSync(join(dir, "barrel.ts"), 'export type { Shape } from "./library.ts"; export const local = 1;');
    writeFileSync(entry, entrySource);
    return analyze(entry, { backend: "rust", allowEngine: false, target }).coverage;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test.each([
  'import type { Shape } from "./library.ts";',
  'import type * as Library from "./library.ts"; type Shape = Library.Shape;',
  'import { type Shape, local } from "./barrel.ts"; console.log(local);',
])("type-only runtime graph erases %s without discarding its types", imports => {
  const coverage = coverageOf(`${imports}\nconst value: Shape = { label: "native" }; console.log(value.label);`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution?.engine).toBe("none");
});

test("type-only runtime graph retains checker errors in the importing file", () => {
  const coverage = coverageOf('import type { Shape } from "./library.ts"; const value: Shape = { label: 3 };');
  expect(coverage.preflightFailed).toBe(true);
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC0001", message: expect.stringContaining("not assignable") }),
  ]);
});

test.each([
  'import { type Shape } from "./library.ts";',
  'export { type Shape } from "./library.ts";',
])("Bun elides inline-only type edges for %s", source => {
  const coverage = coverageOf(source + '\nconsole.log("bun");', undefined, "bun");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution?.engine).toBe("none");
});

test("type-only runtime graph retains checker errors inside an erased module", () => {
  const coverage = coverageOf('import type { Shape } from "./library.ts"; console.log("native");',
    'export interface Shape { label: string } const invalid: number = "wrong";');
  expect(coverage.preflightFailed).toBe(true);
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC0001", message: expect.stringContaining("not assignable") }),
  ]);
});

test.each([
  'import { value } from "./library.ts"; console.log(value);',
  'import { type Shape, value } from "./library.ts"; console.log(value);',
  'import { type Shape } from "./library.ts";',
  'export { type Shape } from "./library.ts";',
  'import "./library.ts";',
  'import {} from "./library.ts";',
  'export * from "./library.ts";',
  'async function main() { await import("./library.ts"); } main();',
  'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); require("./library.ts");',
  'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./library.ts");',
  'import { fork } from "node:child_process"; fork(new URL("./library.ts", import.meta.url));',
])("type-only runtime graph preserves runtime refusal for %s", source => {
  const coverage = coverageOf(source, 'import "node:inspector"; export interface Shape { label: string } export const value = 7;');
  expect(coverage.diagnostics).toEqual([
    expect.objectContaining({ code: "SC1010", message: expect.stringContaining("inspector") }),
  ]);
});

test.each([
  "tests/corpus/3336-type-only-runtime-graph/main.ts",
  "tests/corpus/3337-type-only-link-graph/main.ts",
  "tests/fixtures/type-only-npm-graph/main.ts",
])("Rust compiles %s without an engine", async fixture => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-type-only-native-"));
  try {
    const result = await compile(resolve(fixture), {
      backend: "rust", allowEngine: false, npmStatic: "auto", outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    expect(result.runtimeFences).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
