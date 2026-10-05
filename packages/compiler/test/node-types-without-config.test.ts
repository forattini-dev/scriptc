import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

const require = createRequire(import.meta.url);

test("Rust adopts installed Node declarations without a tsconfig and preserves type-only imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-node-types-no-config-"));
  try {
    await mkdir(join(dir, "node_modules", "@types"), { recursive: true });
    await symlink(dirname(require.resolve("@types/node/package.json")), join(dir, "node_modules", "@types", "node"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(dir, "checksum.d.ts"), `
declare const ChecksumStream_base: any;
/** @extends ReadableStream */
export declare class ChecksumStream extends ChecksumStream_base {}
`);
    const entry = join(dir, "main.mts");
    await writeFile(entry, `
import type { AgentOptions } from "node:https";
import type { ReadableStream } from "node:stream/web";
import type { ChecksumStream } from "./checksum.js";
type NodeSurface = [AgentOptions, ReadableStream, ChecksumStream];
console.log("installed Node types without a tsconfig");
`);
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const [node, rust] = await Promise.all([
      runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]),
      runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
    ]);
    expect(node.code).toBe(0);
    expect(node.signal).toBe(null);
    expect(rust.code, rust.stderr.toString("utf8")).toBe(node.code);
    expect(rust.signal).toBe(null);
    expect(rust.stdout.toString("utf8")).toBe("installed Node types without a tsconfig\n");
    expect(rust.stdout).toEqual(node.stdout);
    expect(rust.stderr).toEqual(node.stderr);
    // Library-internal diagnostics do not relax errors in the application.
    await writeFile(entry, 'import type { AgentOptions } from "node:https"; const options: AgentOptions = { keepAlive: "wrong" };');
    const invalid = await compile(entry, {
      backend: "rust", allowEngine: false, outDir: dir, outPath: join(dir, "invalid"),
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.diagnostics).toEqual([
      expect.objectContaining({ code: "SC0001", message: expect.stringContaining("not assignable") }),
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ancestor Node declarations do not replace an unconfigured isolated program's fallback surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-node-types-ancestor-"));
  try {
    await mkdir(join(dir, "node_modules", "@types"), { recursive: true });
    await symlink(dirname(require.resolve("@types/node/package.json")), join(dir, "node_modules", "@types", "node"), process.platform === "win32" ? "junction" : "dir");
    const isolated = join(dir, "isolated");
    await mkdir(isolated);
    const entry = join(isolated, "main.mts");
    // This implemented Node property is missing from the adopted upstream
    // declarations, but belongs to scriptc's documented fallback surface.
    await writeFile(entry, 'import { StringDecoder } from "node:string_decoder"; console.log(new StringDecoder("utf8").encoding);');
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization: "dev", outDir: isolated, outPath: join(isolated, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    const [node, rust] = await Promise.all([
      runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]),
      runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
    ]);
    expect(node.code).toBe(0);
    expect(node.signal).toBe(null);
    expect(rust.code, rust.stderr.toString("utf8")).toBe(node.code);
    expect(rust.signal).toBe(null);
    expect(rust.stdout.toString("utf8")).toBe("utf8\n");
    expect(rust.stdout).toEqual(node.stdout);
    expect(rust.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
