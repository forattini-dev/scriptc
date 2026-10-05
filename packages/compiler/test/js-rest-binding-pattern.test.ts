import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

for (const backend of ["rust", "llvm"] as const) test.each([
  ["3358-js-rest-binding-pattern.js", "first 1\ntrue\nfallback undefined\nfallback second\nvalue tail\nkept\n"],
  ["2085-destructuring-heads-rest-params.ts", '1 2\n3 4\n"" true\nkey ""\nval true\no 7\no 3\na 1 b 2\n3\n56 16 12\n'],
])(`${backend} rest patterns preserve JavaScript packing and typed tuple semantics: %s`, async (fixture, stdout) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-rest-pattern-"));
  try {
    const entry = resolve("tests/corpus", fixture);
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
    expect(native.stdout.toString("utf8")).toBe(stdout);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a checked-dynamic rest tail retains its explicit destructuring refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-rest-tail-refusal-"));
  try {
    const entry = join(dir, "main.mjs");
    await writeFile(entry, '// @ts-nocheck\nfunction f(...[first, ...tail]) { console.log(tail.length); } f(1, 2);');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("[SC1031] rest elements over checked-dynamic sources") }),
    ]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
