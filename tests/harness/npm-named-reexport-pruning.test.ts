/* Demand-driven pruning of named re-exports in a sideEffects-free ESM
 * package (npm-static-prune.ts), proven both ways: the pruning program
 * compiles without an engine to a binary byte-identical to Node on both
 * matrix targets with ZERO runtime fences although the barrel re-exports a
 * module whose construct the lowering fences (fenced.js) — and the
 * controls show the fence is real (demanding that name refuses the build)
 * and that a package WITHOUT the sideEffects promise keeps evaluating its
 * unused modules exactly where Node does. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { analyze, compile, NODE_COMPAT_MATRIX, type RuntimeTargetId } from "@scriptc/compiler";
import { oracleExecutableForTarget } from "./node-matrix.js";
import { runFileStdio } from "./file-stdio.js";

const TARGETS: readonly RuntimeTargetId[] = ["node26", "node24"];
const corpus = (fixture: string, entry = "main.ts") => resolve("tests/corpus", fixture, entry);

const MISSION_OPTIONS = { backend: "rust", allowEngine: false, npmStatic: "auto", optimization: "dev" } as const;

async function compileEngineFree(entry: string, target: RuntimeTargetId, directory: string) {
  return compile(entry, { ...MISSION_OPTIONS, target, outDir: directory, outPath: join(directory, "program") });
}

/** The coverage view of the same build: the per-package audit of what the
 * program never evaluates rides the npm-static status rows. */
function npmStaticStatuses(entry: string, target: RuntimeTargetId) {
  const { coverage } = analyze(entry, { ...MISSION_OPTIONS, target });
  expect(coverage.preflightFailed).toBe(false);
  return { diagnostics: coverage.diagnostics, runtimeFences: coverage.runtimeFences ?? [], npmStatic: coverage.npmStatic ?? [] };
}

/** The binary's stdout, stderr and exit status must equal the target's
 * pinned Node interpreter's, byte for byte. */
async function expectNodeParity(binaryPath: string, entry: string, target: RuntimeTargetId, expectedStdout: string) {
  const oracle = await runFileStdio(oracleExecutableForTarget(target, NODE_COMPAT_MATRIX), [entry]);
  expect(oracle.code, oracle.stderr.toString()).toBe(0);
  expect(oracle.stdout.toString()).toBe(expectedStdout);
  const native = await runFileStdio(binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
  expect(native.code, native.stderr.toString()).toBe(oracle.code);
  expect(native.signal).toBe(oracle.signal);
  expect(native.stdout).toEqual(oracle.stdout);
  expect(native.stderr).toEqual(oracle.stderr);
}

describe("npm static named re-export pruning", () => {
  test.each(TARGETS)("a pure barrel admits only the demanded modules and compiles fence-free (%s)", async (target) => {
    const directory = await mkdtemp(join(tmpdir(), "scriptc-named-reexport-"));
    const entry = corpus("3470-npm-named-reexport-pruning");
    try {
      const result = await compileEngineFree(entry, target, directory);
      expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      expect(result.execution).toEqual({ engine: "none", externalFfi: false });
      expect(result.runtimeFences).toEqual([]);
      const coverage = npmStaticStatuses(entry, target);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.runtimeFences).toEqual([]);
      expect(coverage.npmStatic).toEqual([{
        package: "pure-barrel",
        status: "static",
        // fenced.js and chain/spare.js hang off names nobody demands;
        // meta-extra.js is behind a star whose names are known.
        prunedModules: ["chain/spare.js", "fenced.js", "meta-extra.js"],
      }]);
      await expectNodeParity(result.binaryPath, entry, target, "hello, scriptc\nNAMED RE-EXPORTS!\n6\n1.0.0 pure-barrel@1.0.0\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("demanding the fenced module's name admits it and the engine-free build refuses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scriptc-named-reexport-"));
    try {
      const result = await compileEngineFree(corpus("3470-npm-named-reexport-pruning", "demand-fenced.ts"), "node26", directory);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.map((d) => d.code)).toEqual(["SC3003"]);
      expect(result.diagnostics[0]!.message).toContain("Math methods as values");
      expect(result.diagnostics[0]!.loc.file.endsWith("/pure-barrel/fenced.js")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(TARGETS)("a package without the sideEffects promise keeps evaluating its unused modules in Node's order (%s)", async (target) => {
    const directory = await mkdtemp(join(tmpdir(), "scriptc-named-reexport-"));
    const entry = corpus("3471-npm-named-reexport-stateful");
    try {
      const result = await compileEngineFree(entry, target, directory);
      expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      expect(result.runtimeFences).toEqual([]);
      expect(npmStaticStatuses(entry, target).npmStatic).toEqual([{ package: "stateful-barrel", status: "static" }]);
      await expectNodeParity(result.binaryPath, entry, target, "counter module initialized\nregistry module initialized\nmain\nhello, scriptc\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
