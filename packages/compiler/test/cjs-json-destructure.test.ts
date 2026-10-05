import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

const cases = [
  ["3441-cjs-json-destructure", "1.0.0:7:stream:9:true:5\n", "json-binding\n"],
  ["3442-cjs-json-destructure-cache", "before:12\nafter 12\n", ""],
] as const;

test.each(cases)("native preflight admits %s", (name) => {
  const { coverage } = analyze(resolve(`tests/corpus/${name}/main.cjs`), { backend: "rust", allowEngine: false });
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.preflightFailed).toBe(false);
});

test.each(cases)("Rust preserves JSON destructuring and cache semantics in %s", async (name, stdout, stderr) => {
  const entry = resolve(`tests/corpus/${name}/main.cjs`);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-json-destructure-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBeNull();
    expect(node.stdout.toString()).toBe(stdout);
    expect(node.stderr.toString()).toBe(stderr);
    for (const optimization of ["dev", "release"] as const) {
      const result = await compile(entry, {
        backend: "rust", allowEngine: false, optimization,
        outDir: directory, outPath: join(directory, `program-${optimization}`),
      });
      expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      expect(result.execution).toEqual({ engine: "none", externalFfi: false });
      expect(result.runtimeFences).toEqual([]);
      const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
      expect(native.code, native.stderr.toString()).toBe(node.code);
      expect(native.signal).toBe(node.signal);
      expect(native.stdout).toEqual(node.stdout);
      expect(native.stderr).toEqual(node.stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 180_000);

test.each([
  ["tests/corpus/1359-json-module/main.ts", undefined],
  ["tests/fixtures/npm/cases/json-require/main.ts", ["jsonzoo"]],
] as const)("Rust preserves existing JSON imports in %s", async (path, packages) => {
  const entry = resolve(path);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-json-import-regression-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBeNull();
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization: "dev", npmStatic: packages && [...packages],
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 180_000);

test.each([
  '{ version = "fallback" }',
  "{ ...rest }",
  "{ nested: { count } }",
  '{ ["version"]: version }',
])("JSON require keeps an explicit refusal for %s", async pattern => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-json-pattern-refusal-"));
  try {
    await writeFile(join(directory, "data.json"), '{"version":"1.0.0","nested":{"count":1}}\n');
    const entry = join(directory, "main.cjs");
    await writeFile(entry, `const ${pattern} = require("./data.json");\n`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code: "SC1012" }));
    const result = await compile(entry, { backend: "rust", allowEngine: false, outDir: directory, outPath: join(directory, "must-not-build") });
    expect(result.ok).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
