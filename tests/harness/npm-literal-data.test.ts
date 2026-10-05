import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile, isRuntimeTargetId, NODE_COMPAT_MATRIX } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";
import { runFileStdio } from "./file-stdio.js";

test.each([
  ["3456-npm-literal-data", "dev", "alpha:beta\ntrue false\n"],
  ["3456-npm-literal-data", "release", "alpha:beta\ntrue false\n"],
  ["3457-npm-lazy-admission", "dev", "outer init\nmain\nload\ninner init\nlazy init\n42\nload\n42\n"],
  ["3457-npm-lazy-admission", "release", "outer init\nmain\nload\ninner init\nlazy init\n42\nload\n42\n"],
] as const)("AUTO runtime frontier compiles without an engine (%s, %s)", async (fixture, optimization, expected) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-npm-literal-data-"));
  const target = process.env["SCRIPTC_RUNTIME_TARGET"];
  if (target !== undefined && !isRuntimeTargetId(target)) throw new Error(`invalid target: ${target}`);
  const entry = resolve("tests/corpus", fixture, "main.ts");
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, npmStatic: "auto", optimization,
      ...(target === undefined ? {} : { target }), outDir: directory, outPath: join(directory, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const oracle = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(oracle.code, oracle.stderr.toString()).toBe(0);
    expect(oracle.stdout.toString()).toBe(expected);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(oracle.code);
    expect(native.signal).toBe(oracle.signal);
    expect(native.stdout).toEqual(oracle.stdout);
    expect(native.stderr).toEqual(oracle.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
