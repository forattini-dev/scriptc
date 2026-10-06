import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

// Class expressions evaluated inside functions (class templates): one shape,
// one class object per evaluation. Rust, no engine, byte parity with Node.
for (const optimization of ["dev", "release"] as const) test.each([
  ["tests/corpus/3490-ts-class-template-identity.ts"],
  ["tests/corpus/3491-js-class-template-builder.mjs"],
  ["tests/corpus/3492-js-class-template-builder-chain.mjs"],
  ["tests/corpus/3493-ts-class-template-extends.ts"],
  ["tests/fixtures/class-templates/factory-repeated-call.ts"],
  ["tests/fixtures/class-templates/factory-multi-declarator.ts"],
  ["tests/fixtures/class-templates/builder-repeat.mjs"],
  ["tests/fixtures/class-factory/builder-effects.mjs"],
])(`Rust ${optimization} evaluates class templates: %s`, async (fixture) => {
  const entry = resolve(fixture);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-class-templates-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.signal).toBeNull();
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization,
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout, native.stdout.toString()).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["static-field.ts", "static fields in class expressions evaluated inside functions"],
  ["reassigned-capture.ts", "capturing the reassigned binding 'tag'"],
  ["private-name.ts", "private names (their brand is per evaluation)"],
  ["prototype-read.ts", "reading 'prototype' through the value of a class evaluated inside a function"],
  ["template-over-template.ts", "extending a class evaluated inside a function from a class that may itself evaluate more than once"],
  ["parameter-base.mjs", "method calls like 'new (mix(Base))().more'"],
  ["extends-union.mjs", "extending computed expressions"],
  ["extends-dyn.mjs", "extending computed expressions"],
  ["extends-builtin.ts", "extending a class evaluated inside a function whose template was refused (extending classes not declared in the program ('Uint8Array'))"],
  ["extends-in-function.ts", "extending a class evaluated inside a function from a class that may itself evaluate more than once"],
])("keeps a named class template boundary: %s", async (fixture, message) => {
  const result = await compile(resolve("tests/fixtures/class-templates", fixture), { backend: "rust", allowEngine: false });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.some(diagnostic =>
    (diagnostic.code === "SC1090" || (diagnostic.code === "SC3003" && diagnostic.message.includes("[SC1090]"))) &&
    diagnostic.message.includes(message)), JSON.stringify(result.diagnostics)).toBe(true);
  expect(result.diagnostics.some(diagnostic => diagnostic.code === "SC9001")).toBe(false);
});

// The heritage evaluates at the class statement: a base still in its
// temporal dead zone throws Node's ReferenceError (uncaught: stdout and
// exit status match; the uncaught report's stack format is not compared).
test("a class template heritage in its temporal dead zone throws Node's ReferenceError", async () => {
  const entry = resolve("tests/fixtures/class-templates/heritage-tdz.ts");
  const directory = await mkdtemp(join(tmpdir(), "scriptc-class-templates-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    const result = await compile(entry, { backend: "rust", allowEngine: false, outDir: directory, outPath: join(directory, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.stdout).toEqual(node.stdout);
    expect(native.code).toBe(node.code);
    const message = "ReferenceError: Cannot access 'Late' before initialization";
    expect(node.stderr.toString()).toContain(message);
    expect(native.stderr.toString()).toContain(message);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A refused heritage argument is a diagnostic at the class statement, never
// a lowering crash that escapes the module initializer.
test("a refused class template heritage reports instead of crashing", async () => {
  const result = await compile(resolve("tests/fixtures/class-templates/heritage-refused-argument.ts"), { backend: "rust", allowEngine: false });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.some(diagnostic => diagnostic.code === "SC2020" && diagnostic.message.includes("'eval'")),
    JSON.stringify(result.diagnostics)).toBe(true);
  expect(result.diagnostics.some(diagnostic => diagnostic.code === "SC9001")).toBe(false);
});
