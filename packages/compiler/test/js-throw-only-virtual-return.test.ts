import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each((["rust", "llvm"] as const).flatMap((backend) => [
  { backend, fixture: "3359-js-throw-only-virtual-return.js", expected: "application/json\nbase-called\nimplementation missing\n" },
  { backend, fixture: "3360-js-throw-only-virtual-family.js", expected: "42\n43\nfalse\nempty\nundefined\nmissing\n" },
]))("$backend virtual calls preserve override values and base throws: $fixture", async ({ backend, fixture, expected }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-throw-only-return-"));
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
    expect(native.code, native.stderr.toString("utf8")).toBe(node.code);
    expect(native.signal).toBe(null);
    expect(native.stdout.toString("utf8")).toBe(expected);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an async JavaScript override cannot silently inherit a synchronous throw-only slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-throw-only-async-"));
  try {
    const entry = join(dir, "main.mjs");
    await writeFile(entry, `// @ts-nocheck
class Base { value() { throw new Error("missing"); } }
class Derived extends Base { async value() { return "value"; } }
new Derived();
`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("[SC1090] overriding a method with an async method 'value'") }),
    ]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["parameter mismatch", "mjs", 'class Base { value() { throw new Error("missing"); } } class Derived extends Base { value(x) { return x; } }'],
  ["ordinary void base", "mjs", 'class Base { value() { console.log("base"); } } class Derived extends Base { value() { return "value"; } }'],
  ["typed void contract", "ts", 'class Base { value(): void { throw new Error("missing"); } } class Derived extends Base { value(): string { return "value"; } }'],
  ["earlier return", "mjs", 'class Base { value() { return; throw new Error("unreachable"); } } class Derived extends Base { value() { return "value"; } }'],
  ["finally completion", "mjs", 'class Base { value() { try { throw new Error("missing"); } finally { return; } } } class Derived extends Base { value() { return "value"; } }'],
])("throw-only virtual returns retain the signature refusal for %s", async (_, extension, source) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-throw-only-refusal-"));
  try {
    const entry = join(dir, `main.${extension}`);
    await writeFile(entry, `// @ts-nocheck\n${source}\nnew Derived();\n`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: extension === "ts" ? "SC1090" : "SC3003", message: expect.stringContaining("overriding a method with a different signature") }),
    ]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
