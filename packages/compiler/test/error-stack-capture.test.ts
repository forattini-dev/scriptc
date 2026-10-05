import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each([
  { file: "3384-error-stack-capture.cjs", behavior: "captures the source callsite and formats the header on first read", stdout: (entry: string) => `undefined Changed: after\n    at leaf (${entry}:5:24)\ntrue\n` },
  { file: "3385-error-stack-exclude.cjs", behavior: "excludes the matching function and clears frames when it is absent", stdout: (entry: string) => `Error: filtered\n    at outer (${entry}:8:27)\nError: filtered\n` },
  { file: "3386-error-stack-class.cjs", behavior: "cuts inherited capture at the runtime constructor identity", stdout: (entry: string) => `LeafError LeafError: class\n    at build (${entry}:13:27)\nfalse false\n` },
  { file: "3387-error-stack-effects.cjs", behavior: "evaluates capture and stack receivers exactly once", stdout: () => "1\nError: effects\n2\n" },
  { file: "3388-error-stack-new.cjs", behavior: "captures builtin Error creation before the first stack read", stdout: (entry: string) => `Error: changed\n    at make (${entry}:4:10)\n    at Object.<anonymous> (${entry}:6:15)\n` },
  { file: "3389-error-stack-subclass-new.cjs", behavior: "captures native Error subclasses at super construction", stdout: (entry: string) => `Error: created\n    at make (${entry}:6:26)\n    at Object.<anonymous> (${entry}:7:15)\n` },
  { file: "3390-error-stack-esm.mjs", behavior: "preserves ESM file URLs and anonymous top-level callsites", stdout: (entry: string) => `    at leaf (${pathToFileURL(entry).href}:5:9)\n    at ${pathToFileURL(entry).href}:8:15\n` },
  { file: "3391-error-stack-capability-fallback.cjs", behavior: "accepts an unreachable stack-write capability fallback", stdout: (entry: string) => `CustomError: fallback\n    at make (${entry}:14:26)\n` },
].flatMap(entry => (["dev", "release"] as const).map(optimization => ({ ...entry, optimization }))))("Rust $optimization $behavior", async ({ file, stdout, optimization }) => {
  const entry = resolve("tests/corpus", file);
  const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
  expect(node.code).toBe(0);
  expect(node.signal).toBe(null);
  expect(node.stderr.length).toBe(0);
  expect(node.stdout.toString()).toBe(stdout(entry));
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-stack-"));
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, optimization, outDir: dir, outPath: join(dir, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(null);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Rust explicitly fences an executed Error stack write", async () => {
  const entry = resolve("tests/fixtures/error-stack/write.cjs");
  const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
  expect(node.code).toBe(0);
  expect(node.stderr.length).toBe(0);
  expect(node.stdout.toString()).toBe("manual\n");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-stack-write-"));
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(0);
    expect(native.stderr.length).toBe(0);
    expect(native.stdout.toString()).toBe("scriptc SC1031: native Error stack writes are not implemented\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["own-stack.cjs", "shadowed Error stack property", "Error: message\n"],
  ["message-getter.cjs", "accessors sharing a name with a field", "Error: getter\n"],
  ["async.cjs", "Error source stacks with async or generator functions", "Error: async\n"],
] as const)("Rust refuses unqualified stack shape %s", async (file, reason, stdout) => {
  const entry = resolve("tests/fixtures/error-stack", file);
  const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
  expect(node.code).toBe(0);
  expect(node.stderr.length).toBe(0);
  expect(node.stdout.toString()).toBe(stdout);
  const result = analyze(entry, { backend: "rust", allowEngine: false });
  expect(result.coverage.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(reason) })]));
});
