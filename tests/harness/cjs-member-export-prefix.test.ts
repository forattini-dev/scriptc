import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile, isRuntimeTargetId, NODE_COMPAT_MATRIX } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";
import { runFileStdio } from "./file-stdio.js";

test.each(["dev", "release"] as const)("Rust %s defers reads of require bindings captured by CommonJS member exports", async optimization => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-cjs-member-prefix-"));
  const target = process.env["SCRIPTC_RUNTIME_TARGET"];
  if (target !== undefined && !isRuntimeTargetId(target)) throw new Error(`invalid target: ${target}`);
  const entry = resolve("tests/corpus/3458-cjs-member-export-prefix/main.cjs");
  try {
    const oracle = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(oracle.code, oracle.stderr.toString()).toBe(0);
    expect(oracle.stdout.toString()).toBe("whole init\nmember:[42]\nnested:[tail]\nwhole:[done]\nfunction function function\n");
    expect(oracle.stderr.toString()).toBe("");
    const result = await compile(entry, { backend: "rust", allowEngine: false, optimization,
      ...(target === undefined ? {} : { target }), outDir: directory, outPath: join(directory, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(oracle.code);
    expect(native.signal).toBe(oracle.signal);
    expect(native.stdout).toEqual(oracle.stdout);
    expect(native.stderr).toEqual(oracle.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
