import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each(["rust", "llvm"] as const)("%s TypedArray.from coerces numeric elements and makes independent copies", async (backend) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-typed-array-from-"));
  try {
    const entry = resolve("tests/corpus/3356-typed-array-from.ts");
    const result = await compile(entry, {
      backend, sanitize: backend === "llvm" && process.env["SCRIPTC_SAN"] === "1",
      allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program"),
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
    expect(native.code, native.stderr.toString("utf8")).toBe(node.code);
    expect(native.signal).toBe(null);
    expect(native.stdout.toString("utf8")).toBe("0 4294967295 1 3 4294967293 0 0\n0 -1 1 3 -3 0 0\n0 42\n1 255 1\n1.5 -2.25\n1.5 -2.25\n0\n7 8 1\n11\n");
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["mapper", "Uint32Array.from([1], x => x + 1)"],
  ["thisArg", "Uint32Array.from([1], x => x, {})"],
  ["cross-kind typed array", "Uint32Array.from(new Int32Array([1]))"],
  ["Set iterable", "Uint32Array.from(new Set([1]))"],
  ["numeric allocation", "Uint32Array.from(3)"],
])("TypedArray.from retains an explicit refusal for %s", async (_, expression) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-typed-array-from-refusal-"));
  try {
    const entry = join(dir, "main.mjs");
    await writeFile(entry, `console.log(${expression});`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("[SC2020] 'Uint32Array.from") }),
    ]));
    expect(coverage.stats.statementsIsland).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
