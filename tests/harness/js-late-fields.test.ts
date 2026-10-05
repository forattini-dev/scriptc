import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile, isRuntimeTargetId, NODE_COMPAT_MATRIX } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";
import { runFileStdio } from "./file-stdio.js";

test.each(["dev", "release"] as const)("native JS late dynamic fields preserve reads and writes (%s)", async optimization => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-js-late-fields-"));
  const target = process.env["SCRIPTC_RUNTIME_TARGET"];
  if (target !== undefined && !isRuntimeTargetId(target)) throw new Error(`invalid target: ${target}`);
  const entry = resolve("tests/corpus/3455-js-late-dynamic-class-fields.js");
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, optimization,
      ...(target === undefined ? {} : { target }), outDir: directory, outPath: join(directory, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const oracle = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(oracle.code, oracle.stderr.toString()).toBe(0);
    expect(oracle.stdout.length).toBeGreaterThan(0);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(oracle.code);
    expect(native.signal).toBe(oracle.signal);
    expect(native.stdout).toEqual(oracle.stdout);
    expect(native.stderr).toEqual(oracle.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
