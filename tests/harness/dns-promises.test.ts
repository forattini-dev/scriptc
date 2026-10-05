import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile, isRuntimeTargetId, NODE_COMPAT_MATRIX } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";
import { runFileStdio } from "./file-stdio.js";

test.each([
  ["3451-dns-promises-lookup.ts", "dev"], ["3451-dns-promises-lookup.ts", "release"],
  ["3452-dns-promises-errors.js", "dev"], ["3452-dns-promises-errors.js", "release"],
  ["3453-dns-promisify-lookup.js", "dev"], ["3453-dns-promisify-lookup.js", "release"],
  ["3454-js-empty-object-expando.js", "dev"], ["3454-js-empty-object-expando.js", "release"],
] as const)("DNS options and native JS object parity (%s, %s)", async (fixture, optimization) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-dns-promises-"));
  const target = process.env["SCRIPTC_RUNTIME_TARGET"];
  if (target !== undefined && !isRuntimeTargetId(target)) throw new Error(`invalid target: ${target}`);
  const entry = resolve("tests/corpus", fixture);
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, optimization,
      ...(target === undefined ? {} : { target }), outDir: directory, outPath: join(directory, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const oracle = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX),
      [...(fixture.endsWith(".js") ? ["--no-deprecation"] : []), entry]);
    expect(oracle.code, oracle.stderr.toString()).toBe(0);
    expect(oracle.stdout.length).toBeGreaterThan(0);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(oracle.code);
    expect(native.signal).toBe(oracle.signal);
    expect(native.stdout).toEqual(oracle.stdout);
    expect(native.stderr).toEqual(oracle.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["let resolve = promisify(lookup); await resolve('::1');", "SC2020"],
  ["const resolve = promisify(lookup); console.log(resolve);", "SC1090"],
  ["const resolve = promisify(lookup); await resolve('::1', { all: true });", "SC2020"],
  ["const resolve = promisify(lookup); const options: Record<string, number> = {}; await resolve('::1', options);", "SC2020"],
  ["const resolve = promisify(lookup); const options: {} = false; await resolve('::1', options);", "SC2020"],
  ["function ownLookup() {} const resolve = promisify(ownLookup); await resolve('::1');", "SC2020"],
] as const)("promisified DNS preserves its refusal boundary: %s", async (body, code) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-dns-projection-refusal-"));
  try {
    const entry = join(directory, "main.ts");
    await writeFile(entry, `import { lookup } from 'node:dns'; import { promisify } from 'node:util'; ${body}\n`);
    const result = await compile(entry, { backend: "rust", allowEngine: false,
      outputKind: "rust", outDir: join(directory, "out") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.code === code), JSON.stringify(result.diagnostics)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  "lookup('localhost', { all: true })",
  "lookup('localhost', { hints: 32 })",
  "lookup('localhost', { order: 'ipv4first' })",
  "resolve4('localhost')",
])("preserves an explicit refusal for %s", async call => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-dns-promises-refusal-"));
  try {
    const entry = join(directory, "main.ts");
    await writeFile(entry, `import { lookup, resolve4 } from 'node:dns/promises'; console.log(await ${call});\n`);
    const result = await compile(entry, { backend: "rust", allowEngine: false,
      outputKind: "rust", outDir: join(directory, "out") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.code === "SC2020" && d.message.includes("dns/promises")), JSON.stringify(result.diagnostics)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
