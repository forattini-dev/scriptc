import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each((["rust", "llvm", "c"] as const).flatMap((backend) => [
  { backend, fixture: "3363-error-tostring-override.ts", behavior: "a leaf Error.toString override", expected: "custom:DisplayError|broken\n" },
  { backend, fixture: "3364-error-tostring-dispatch.ts", behavior: "virtual Error coercion without virtualizing super", expected: [
    "Error: plain", "Error: plain", "Error: plain",
    "custom[AppError: broken]", "custom[AppError: broken]", "custom[AppError: broken]",
    "custom[AppError: inherited]", "custom[AppError: inherited]", "custom[AppError: inherited]",
    "detail[custom[AppError: detail]]", "detail[custom[AppError: detail]]", "detail[custom[AppError: detail]]",
    "", "", "", "",
  ].join("\n") },
  { backend, fixture: "3365-error-tostring-erased.ts", behavior: "Error overrides through caught and unknown values", expected: [
    "true 7", "AppError | first", "AppError | first", "AppError | later", "AppError | later",
    "plain", "plain",
    "AppError | later", "AppError | later", "AppError | later", "AppError | later", "AppError | later",
    "primitive", "",
  ].join("\n") },
  { backend, fixture: "3366-error-tostring-late-class.ts", behavior: "an override discovered after the first Error call", expected: "late\n" },
  { backend, fixture: "3367-error-tostring-late-dispatch.ts", behavior: "a late override reaches its emitted method", expected: "known\nlate\n" },
  { backend, fixture: "3368-error-tostring-own-hooks.js", behavior: "own hooks and mutable non-overridden Error snapshots keep precedence", expected: "prototype\nprototype\nown\nown\nRenamed: changed\nRenamed: changed\nRenamed: changed\nRenamed: changed\n" },
  { backend, fixture: "3369-error-tostring-effects.ts", behavior: "override side effects and exceptions propagate once", expected: "render 1 1\nrender 1\nrender 2\nError: render failed 3\nrender 4\nError: render failed 5\n5\n" },
  { backend, fixture: "3370-error-tostring-dynamic-method.js", behavior: "a dynamic method call alone discovers Error overrides", expected: "dynamic prototype\nError: plain\n12\n" },
  ...[
    "1300-errors-basics.ts", "1301-errors-subclass.ts", "1302-errors-typed-catch.ts",
    "1554-caught-into-unknown.ts", "2722-unknown-custom-error-instanceof.ts", "2750-unknown-error-subclass-fields.ts",
  ].map(fixture => ({ backend, fixture, behavior: "existing Error behavior stays Node-exact", expected: null })),
]))("$backend: $fixture: $behavior", async ({ backend, fixture, expected }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-tostring-"));
  try {
    const entry = resolve("tests/corpus", fixture);
    const result = await compile(entry, {
      backend, allowEngine: false, optimization: "dev",
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
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
    if (expected !== null) expect(native.stdout.toString("utf8")).toBe(expected);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each((["rust", "llvm", "c"] as const).flatMap(backend => [
  { backend, base: "Error", prefix: "" },
  { backend, base: "Known", prefix: 'class Known extends Error { toString() { return "known"; } }' },
]))("$backend refuses an async Error.toString override through $base", async ({ backend, base, prefix }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-tostring-async-"));
  try {
    const entry = join(dir, "main.mjs");
    await writeFile(entry, `// @ts-nocheck\n${prefix}\nclass AsyncError extends ${base} { async toString() { return "async"; } }\nnew AsyncError("message");\n`);
    const { coverage } = analyze(entry, { backend, allowEngine: false, target: "node24", dynamic: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("[SC1090] overriding a method with an async method 'toString'") }),
    ]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
