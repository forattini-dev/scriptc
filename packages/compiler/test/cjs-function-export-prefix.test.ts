import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each(["dev", "release"] as const)("Rust %s preserves a CommonJS function exported before its require bindings", async optimization => {
  const entry = resolve("tests/corpus/3415-cjs-function-export-prefix/main.cjs");
  const directory = await mkdtemp(join(tmpdir(), "scriptc-cjs-function-prefix-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBeNull();
    expect(node.stdout.toString()).toBe("item:[42]\nitem:[tail]\nfunction\n");
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
