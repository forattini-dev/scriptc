import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

const cases = [
  ["3377-js-instance-constructor-name.js", "StorageError StorageError: missing\nNotFound NotFound: missing\nNoSuchKey NoSuchKey: missing\n"],
  ["3378-js-instance-constructor-late.js", "StorageError StorageError\nLaterError LaterError\n"],
  ["3379-instance-constructor-late-dispatch.ts", "KnownError\nLaterError\nTypeError\nRangeError\nError\n"],
  ["3380-js-instance-constructor-name-effects.js", "first 1\nfirst first\nsecond second Leaf\n"],
] as const;
const differentialCases = (["rust", "llvm", "c"] as const).flatMap(backend => cases.map(([file, stdout]) => ({ backend, file, stdout })));

test.each(differentialCases)("$backend: $file reads the runtime class name", async ({ backend, file, stdout }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-instance-constructor-"));
  try {
    const entry = resolve("tests/corpus", file);
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBe(null);
    expect(node.stderr.length).toBe(0);
    expect(node.stdout.toString()).toBe(stdout);
    const result = await compile(entry, {
      backend, allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program"),
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout.toString()).toBe(stdout);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["shadowed-constructor.js", "SC3003", "shadowed constructor property", "constructor\n"],
  ["late-shadowed-constructor.ts", "SC1090", "shadowed constructor property", "constructor\n"],
  ["static-getter.js", "SC3003", "shadowed static name", "shadow\n"],
  ["non-string-name.js", "SC3003", "non-string static name fields", "12\n"],
  ["bare-constructor.js", "SC3003", "this.constructor", "true\n"],
] as const)("%s retains an explicit refusal", async (file, code, refusal, stdout) => {
  const entry = resolve("tests/fixtures/instance-constructor-name", file);
  const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
  expect(node.code).toBe(0);
  expect(node.signal).toBe(null);
  expect(node.stderr.length).toBe(0);
  expect(node.stdout.toString()).toBe(stdout);
  const result = analyze(entry, { backend: "rust", allowEngine: false });
  const diagnostic = expect.objectContaining({ code, message: expect.stringContaining(refusal) });
  expect(result.coverage.diagnostics).toEqual(expect.arrayContaining([
    diagnostic,
  ]));
  const dir = await mkdtemp(join(tmpdir(), "scriptc-instance-constructor-refusal-"));
  try {
    const native = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program") });
    expect(native.ok).toBe(false);
    if (!native.ok) expect(native.diagnostics).toEqual(expect.arrayContaining([diagnostic]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
