import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each(["rust", "llvm"] as const)("%s npm-static implicit methods preserve base-typed virtual dispatch and super calls", async (backend) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inherited-methods-"));
  try {
    const entry = resolve("tests/fixtures/npm-static/inherited-methods-cli.ts");
    const result = await compile(entry, {
      backend, allowEngine: false, npmStatic: ["inherited-methods"],
      sanitize: backend === "llvm" && process.env["SCRIPTC_SAN"] === "1",
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
    expect(native.stdout.toString("utf8")).toBe("base 11\nderived 22\nderived 33\nleaf 33\nexpression-derived 44\n");
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit generic methods keep their static-dispatch override refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-generic-override-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, `
class Base { setSerdeContext<T>(context: T): void { console.log(context); } }
class Derived extends Base { setSerdeContext(context: unknown): void { console.log(context); } }
new Derived();
`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC1090", message: expect.stringContaining("overriding the inherited generic method 'setSerdeContext'") }),
    ]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
