import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

for (const optimization of ["dev", "release"] as const) test.each([
  ["3416-js-derived-config-factory.mjs", "local\ntrue false\ntrue\n9\ndefault\nlocal named\nextra,factory,base,derived,factory,base,derived,base\n"],
  ["3417-js-config-factory-tdz.mjs", "ReferenceError Cannot access 'factory' before initialization\nlate\n"],
])(`Rust ${optimization} preserves module-level factory calls and initialization order: %s`, async (fixture, stdout) => {
  const entry = resolve("tests/corpus", fixture);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-derived-config-"));
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
