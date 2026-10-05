import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each(["rust", "llvm"] as const)("%s bare inherited fields reset to undefined at their own initialization position", async (backend) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-field-reset-"));
  try {
    const entry = resolve("tests/corpus/3357-inherited-field-reset.js");
    const result = await compile(entry, {
      backend, allowEngine: false, sanitize: backend === "llvm" && process.env["SCRIPTC_SAN"] === "1",
      optimization: "dev", outDir: dir, outPath: join(dir, "program"),
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
    expect(native.stdout.toString("utf8")).toBe("base base\nfields base undefined\nreset true\nfinal derived\nbase base\nfields base undefined\nreset true\ninherited-constructor true\noptional true\n");
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["non-nullable slot", "/** @type {number} */ config;", "without an initializer"],
  ["type-changing initializer", 'config = "wrong";', "at a different type"],
])("inherited fields retain the refusal for a %s", async (_, field, message) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-field-reset-refusal-"));
  try {
    const entry = join(dir, "main.mjs");
    await writeFile(entry, `// @ts-nocheck
class Base { config = 7; }
class Derived extends Base { ${field} }
console.log(new Derived().config);
`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining(`[SC1090] redeclaring inherited fields ${message}`) }),
    ]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
