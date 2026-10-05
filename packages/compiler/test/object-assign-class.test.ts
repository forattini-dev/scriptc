import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

const programs = [
  ["3381-js-object-assign-class.js", "true 422 true new\n422 true new true\n"],
  ["3382-js-object-assign-class-dynamic.js", "409 true explicit\n500 false old\n"],
  ["3383-object-assign-class-presence.ts", "true undefined true\ntrue old true\ntrue old true\ntrue old true\ntarget,source 7\n"],
] as const;
test.each((["rust", "c", "llvm"] as const).flatMap(backend => programs.map(([file, stdout]) => ({ backend, file, stdout }))))("$backend: $file mutates class fields in place", async ({ backend, file, stdout }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-assign-class-"));
  try {
    const entry = resolve("tests/corpus", file);
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBe(null);
    expect(node.stderr.length).toBe(0);
    expect(node.stdout.toString()).toBe(stdout);
    const result = await compile(entry, { backend, allowEngine: false, optimization: "dev", sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1", outDir: dir, outPath: join(dir, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a string key cannot overwrite a native private field", async () => {
  const entry = resolve("tests/fixtures/object-assign-class/private-field.js");
  const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
  expect(node.code).toBe(0);
  expect(node.signal).toBe(null);
  expect(node.stdout.toString()).toBe("0\n");
  expect(node.stderr.length).toBe(0);
  const diagnostic = expect.objectContaining({ code: "SC3003", message: expect.stringContaining("undeclared public string property '#count'") });
  expect(analyze(entry, { backend: "rust", allowEngine: false }).coverage.diagnostics).toEqual(expect.arrayContaining([diagnostic]));
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-assign-private-"));
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual(expect.arrayContaining([diagnostic]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  { backend: "rust", file: "unknown-key.js", nodeStdout: "copied 7\n", nativeStdout: "SC1031 7\n" },
  { backend: "c", file: "unknown-key.js", nodeStdout: "copied 7\n", nativeStdout: "SC1031 7\n" },
  { backend: "llvm", file: "unknown-key.js", nodeStdout: "copied 7\n", nativeStdout: "SC1031 7\n" },
  { backend: "rust", file: "symbol-key.js", nodeStdout: "copied 7\n", nativeStdout: "SC1031 0\n" },
  { backend: "rust", file: "descriptor.js", nodeStdout: "copied 7\n", nativeStdout: "SC1031 0\n" },
] as const)("$backend: $file retains an explicit runtime boundary", async ({ backend, file, nodeStdout, nativeStdout }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-assign-boundary-"));
  try {
    const entry = resolve("tests/fixtures/object-assign-class", file);
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBe(null);
    expect(node.stderr.length).toBe(0);
    expect(node.stdout.toString()).toBe(nodeStdout);
    const result = await compile(entry, { backend, allowEngine: false, optimization: "dev", sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1", outDir: dir, outPath: join(dir, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(0);
    expect(native.signal).toBe(null);
    expect(native.stdout.toString()).toBe(nativeStdout);
    expect(native.stderr.length).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
