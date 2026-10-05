import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

for (const optimization of ["dev", "release"] as const) test.each([
  ["3418-js-computed-assignment-context.mjs", "0 1 HEADER TRAILER\ntrue true 7\ntrue 11\n42 42 42\n"],
  ["3419-js-computed-assignment-order.mjs", "receiver,key,right true 9\nnew new undefined new\n42 42 undefined\nError key failed\nError right failed\nreceiver,key,right,receiver,fail-key,receiver,key,fail-right\nnull-key\nnull-right\nTypeError Cannot set properties of null (setting 'item')\nnull-key\nnull-right\nTypeError Cannot set properties of undefined (setting 'item')\n"],
  ["3420-js-computed-assignment-array.mjs", "3 false true true 8\n1 1 false\nzero zero\nboolean boolean\n"],
  ["3421-js-computed-assignment-keys.mjs", "true 7 undefined\n2 7 2\nzero boolean\nnull undefined\nzero boolean null undefined\nbigint bigint\n"],
  ["3422-js-computed-assignment-null-keys.mjs", "right\nTypeError Cannot set properties of null\nright\nTypeError Cannot set properties of undefined\nright\nTypeError Cannot set properties of null (setting 'Symbol(item)')\nright\nTypeError Cannot set properties of undefined (setting 'true')\n"],
  ["3423-ts-unknown-computed-assignment.ts", "true\ntrue\n7 7\nTypeError Cannot set properties of null (setting 'number')\n"],
])(`Rust ${optimization} preserves computed assignment values: %s`, async (fixture, stdout) => {
  const entry = resolve("tests/corpus", fixture);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-computed-assignment-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBeNull();
    expect(node.stdout.toString()).toBe(stdout);
    expect(node.stderr.toString()).toBe("");
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
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["object-key-refusal.mjs", "scriptc: native object property-key coercion is not supported yet"],
  ["symbol-array-refusal.mjs", "scriptc: native symbol-keyed assignment on this receiver is not supported yet"],
])("Rust explicitly refuses unqualified computed-key behavior: %s", async (fixture, message) => {
  const entry = resolve("tests/fixtures/computed-assignment", fixture);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-computed-key-refusal-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.stdout.toString()).toBe("42\n");
    expect(node.stderr.toString()).toBe("");
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code).toBe(1);
    expect(native.signal).toBeNull();
    expect(native.stdout.toString()).toBe("");
    expect(native.stderr.toString()).toBe(`Uncaught Error: ${message}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["c", "llvm"] as const)("%s refuses the Rust-only computed-key ABI with a named diagnostic", async backend => {
  const result = await compile(resolve("tests/fixtures/computed-assignment/object-key-refusal.mjs"), {
    backend, allowEngine: false,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "SC3001", message: expect.stringContaining("libCall:dyn.keySetComputed"),
  }));
  expect(result.diagnostics.some(diagnostic => diagnostic.code === "SC9001")).toBe(false);
});

test("computed assignment retains the explicit static-record boundary", async () => {
  const result = await compile(resolve("tests/fixtures/computed-assignment/typed-record-refusal.ts"), {
    backend: "rust", allowEngine: false,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "SC1090", message: expect.stringContaining("assignment to non-variables as an expression"),
  }));
});
