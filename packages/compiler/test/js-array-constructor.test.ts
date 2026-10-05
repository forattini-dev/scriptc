import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

async function differentialProgram(file: string, stdout: string, optimization: "dev" | "release") {
  const entry = resolve("tests/corpus", file);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-js-array-constructor-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code, node.stderr.toString()).toBe(0);
    expect(node.signal).toBeNull();
    expect(node.stderr.toString()).toBe("");
    expect(node.stdout.toString()).toBe(stdout);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each(["dev", "release"] as const)("Rust %s constructs inferred JavaScript arrays with holes, indexed strings and join", async optimization => {
  await differentialProgram("3405-js-array-constructor.js", "holes 3 false true\nwritten 3 true false true a||c\ngrown 6 false false true acf\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s distinguishes Array count and element forms without coercing a string into a length", async optimization => {
  await differentialProgram("3406-js-array-constructor-forms.js", "empty 0 \nitems 3 1|x||\ncount 3 false true ||\nitem 1 true 3\nnull 1 true true\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s validates array lengths and distinguishes holes from undefined and non-index keys", async optimization => {
  await differentialProgram("3407-js-array-constructor-boundaries.js", [
    "invalid -1 RangeError Invalid array length", "invalid 2.5 RangeError Invalid array length",
    "invalid NaN RangeError Invalid array length", "invalid Infinity RangeError Invalid array length",
    "invalid 4294967296 RangeError Invalid array length", "valid -0 0 false",
    "valid 4294967295 4294967295 false", "presence false true false true",
    "truncate 3 false false false true", "properties 3 leading negative fraction maximum",
  ].join("\n") + "\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s constructs fresh arrays and evaluates arguments once in source order", async optimization => {
  await differentialProgram("3408-js-array-constructor-effects.js", "alias 1 true a|\nnested 1 true true\nidentity 1 true true\norder abc a|b|c\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s compiles the original unannotated Base85 allocation/write/join pattern", async optimization => {
  await differentialProgram("3409-js-array-base85-pattern.js", [
    " ", "00 !!", "ff vv", "0001 !!,", "ffff w:P", "000102 !!,/", "ffffff w:Y,",
    "00010203 !!,/)", "ffffffff w:Y/!", "0001020304 !!,/)#;", "000102030405 !!,/)#;i",
    "00010203040506 !!,/)#;iy", "0001020304050607 !!,/)#;iy9", "000102030405060708 !!,/)#;iy9$S",
    "68656c6c6f20e29883 DQy!vFar(.M+",
  ].join("\n") + "\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s supports TypeScript unknown[] constructor storage without an engine", async optimization => {
  await differentialProgram("3410-ts-unknown-array-constructor.ts", "values 3 false true |x|\ncount 2 true\nitem 2\nmixed 1|x|false||\n", optimization);
});

test("Rust retains the named untyped bitwise-input refusal outside the Base85 byte-array ABI", async () => {
  const result = await compile(resolve("tests/fixtures/js-array-constructor/untyped-bitwise-refusal.js"), {
    backend: "rust", allowEngine: false,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "SC3003", message: expect.stringContaining("[SC2011] the '<<' operator on 'any'-typed values"),
  }));
});

test("Rust retains the explicit Array constructor spread refusal", async () => {
  const result = await compile(resolve("tests/fixtures/js-array-constructor/spread-refusal.js"), {
    backend: "rust", allowEngine: false,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    message: expect.stringContaining("Array constructor with spread arguments"),
  }));
});

test.each(["dev", "release"] as const)("Rust %s explicitly refuses unqualified object coercion for array length", async optimization => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-array-length-refusal-"));
  try {
    const entry = resolve("tests/fixtures/js-array-constructor/length-object-refusal.js");
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.stderr.toString()).toBe("");
    expect(node.stdout.toString()).toBe("3\n");
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization, outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code).toBe(1);
    expect(native.signal).toBeNull();
    expect(native.stdout.toString()).toBe("");
    expect(native.stderr.toString()).toBe("Uncaught Error: scriptc: native array length coercion from objects is not supported yet\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["2814-dyn-array-tostring.cjs", "1,x,,2,3,\n"],
  ["2779-dyn-array-with-negative-index.cjs", "[1,2,9] [1,2,3] false\n"],
  ["2787-dyn-array-iterator-alias.cjs", '{"value":10,"done":false}\n{"value":20,"done":false}\n'],
] as const)("Rust preserves existing dense dynamic array behavior (%s)", async (file, stdout) => {
  await differentialProgram(file, stdout, "dev");
});
