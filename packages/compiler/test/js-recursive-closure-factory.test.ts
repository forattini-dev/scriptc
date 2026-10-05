import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each([
  { backend: "rust" as const, fixture: "3361-js-recursive-closure-factory.js", expected: "1 2 1\nfalse\n0 1 2\n" },
  { backend: "llvm" as const, fixture: "3361-js-recursive-closure-factory.js", expected: "1 2 1\nfalse\n0 1 2\n" },
  { backend: "rust" as const, fixture: "3362-js-untyped-closure-factory.js", expected: "7 0\n9 7\n" },
  { backend: "llvm" as const, fixture: "3362-js-untyped-closure-factory.js", expected: "7 0\n9 7\n" },
])("$backend module-scope factories preserve captures and independent instance state: $fixture", async ({ backend, fixture, expected }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-closure-factory-"));
  try {
    const entry = resolve("tests/corpus", fixture);
    const result = await compile(entry, {
      backend, allowEngine: false, optimization: "dev",
      sanitize: backend === "llvm" && process.env["SCRIPTC_SAN"] === "1",
      outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const [node, native] = await Promise.all([
      runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]),
      runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
    ]);
    expect(node.code).toBe(0);
    expect(node.signal).toBe(null);
    expect(native.code, native.stdout.toString("utf8") + native.stderr.toString("utf8")).toBe(node.code);
    expect(native.signal).toBe(null);
    expect(native.stdout.toString("utf8")).toBe(expected);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
