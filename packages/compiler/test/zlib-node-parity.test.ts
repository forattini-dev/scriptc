import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

async function differentialProgram(file: string, expected: string, optimization: "dev" | "release") {
  const entry = resolve("tests/corpus", file);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-zlib-node-parity-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code, node.stderr.toString()).toBe(0);
    expect(node.signal).toBeNull();
    expect(node.stderr.toString()).toBe("");
    expect(node.stdout.toString()).toBe(expected);
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization,
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each(["dev", "release"] as const)("Rust %s level 6 raw deflate matches Node across the maximum match length", async optimization => {
  await differentialProgram("3411-zlib-long-default.ts", [
    "4b4c4a4e1c4549c900", "true",
    "4b4c4a4e1c45600400", "true",
    "cb48cdc9c9577834a339639481c40000", "true",
    "cb48cdc9c9577834a339639431ca209d0100", "true",
    "cb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b151ecd68c6a26e54f5a8eac1ac1a00", "true",
  ].join("\n") + "\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s preserves Node default raw, zlib and gzip framing with long matches", async optimization => {
  await differentialProgram("3412-zlib-default-framing.ts", [
    "789c4b4c4a4e1c4560040083b86637",
    "4b4c4a4e1c45600400",
    "1f8b08000000000000034b4c4a4e1c456004000f72ec570b010000",
    "true", "true", "true",
  ].join("\n") + "\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s compresses a repeated three-byte tail like Node", async optimization => {
  await differentialProgram("3413-zlib-three-byte-tail.ts", "63626066022200\n02000302000302\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s preserves Node's compression choice when a short repetition has a different following byte", async optimization => {
  await differentialProgram("3414-zlib-hash-chain-choice.ts", "6bfac932f91a10870100\n82f90493d6f9049356\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s discards three-byte matches beyond Node's distance boundary", async optimization => {
  await differentialProgram("3443-zlib-distant-three-byte-match.ts", [
    "4095 edd7010d0020080030409cc50dae3386fb5b7c668d5e010000007cecf67fbffe1f", "true",
    "4096 edd7010d0020080030409cc50dae3386fb5b7c668d5e01000000fcecfe7fbfff1f", "true",
    "4097 edd809090020100030efc3e206178c215b8c4d64f55e000000c0d722ebbc00b8", "true",
    "8192 edd909090020100030efc3e206176c216c353691d57b01000000000000003f8bacf3feff02", "true",
  ].join("\n") + "\n", optimization);
});
