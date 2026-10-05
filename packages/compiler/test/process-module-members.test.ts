import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

async function assertCorpus(fixture: string, stdout: string, backend: "rust" | "llvm" = "rust"): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-process-module-"));
  try {
    const entry = resolve("tests/corpus", fixture);
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
    expect(native.stdout.toString("utf8")).toBe(stdout);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("Rust named process.env imports keep live reads, writes, deletes and lexical shadowing", async () => {
  await assertCorpus("3352-process-module-env-import.ts", "absent\nglobal\nalias\ndeleted\nlocal\n");
});

test("Rust destructured process.env requires preserve computed live reads, writes and deletes", async () => {
  await assertCorpus("3353-process-module-env-require.cjs", "absent\nglobal\nalias\ndeleted\n");
});

test("Rust named process.versions imports preserve target identity and lexical shadowing", async () => {
  await assertCorpus("3354-process-module-versions-import.ts", "24.15.0\ntrue\nlocal\n");
});

test("Rust admits the AWS SDK's combined versions and env require bindings", async () => {
  await assertCorpus("3355-process-module-combined-require.cjs", "24.15.0\ncombined\ndeleted\n");
});

test("LLVM process member bindings preserve imported and destructured live env access", async () => {
  await assertCorpus("3352-process-module-env-import.ts", "absent\nglobal\nalias\ndeleted\nlocal\n", "llvm");
  await assertCorpus("3353-process-module-env-require.cjs", "absent\nglobal\nalias\ndeleted\n", "llvm");
});

test.each([
  ["unsupported named member", "main.mjs", 'import { env, memoryUsage } from "node:process"; console.log(memoryUsage());'],
  ["unsupported require member", "main.cjs", 'const { env, memoryUsage } = require("node:process"); console.log(memoryUsage());'],
  ["mutable destructuring", "main.cjs", 'let { env } = require("node:process"); console.log(env.PATH);'],
  ["default initializer", "main.cjs", 'const { env = {} } = require("node:process"); console.log(env.PATH);'],
  ["rest binding", "main.cjs", 'const { env, ...rest } = require("node:process"); console.log(env.PATH);'],
  ["nested binding", "main.cjs", 'const { env: { PATH } } = require("node:process"); console.log(PATH);'],
  ["computed binding", "main.cjs", 'const key = "env"; const { [key]: env } = require("node:process"); console.log(env.PATH);'],
])("process member admission keeps the refusal for %s", async (description, filename, source) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-process-refusal-"));
  try {
    const entry = join(dir, filename);
    await writeFile(entry, source);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    const expected = description === "nested binding"
      ? { code: "SC1012", message: expect.stringContaining("nested patterns") }
      : { code: "SC3003", message: expect.stringContaining("[SC1010]") };
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining(expected),
    ]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
