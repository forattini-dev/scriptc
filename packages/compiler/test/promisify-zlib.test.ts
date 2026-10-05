import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

async function differentialProgram(file: string, stdout: string, optimization: "dev" | "release") {
  const entry = resolve("tests/corpus", file);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-promisify-zlib-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.stderr.toString()).toBe("");
    expect(node.stdout.toString()).toBe(stdout);
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization,
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test.each(["dev", "release"] as const)("Rust %s promisified raw zlib returns buffers after queued microtasks", async optimization => {
  await differentialProgram("3393-promisify-zlib-raw.ts", "scheduled\nmicrotask\npacked\ncb48cdc9c90700\nhello\n", optimization);
});

test.each(["dev", "release"] as const)("Rust %s promisified deflateRaw observes a numeric level option", async optimization => {
  await differentialProgram("3394-promisify-zlib-level.ts", [
    "0 012900d6ff68656c6c6f2068656c6c6f2068656c6c6f2068656c6c6f20636f6d7072657373696f6e20776f726b73",
    "hello hello hello hello compression works",
    "6 cb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b01",
    "hello hello hello hello compression works",
    "9 cb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b01",
    "hello hello hello hello compression works", "",
  ].join("\n"), optimization);
});

test.each(["dev", "release"] as const)("Rust %s promisified deflateRaw UTF-8 encodes string input", async optimization => {
  await differentialProgram("3395-promisify-zlib-string.ts", "cb48cdc9c9577834a31900\nhello ☃\n", optimization);
});

test("Rust level 6 raw compression matches Node long-text bytes and retains interoperability", async () => {
  const entry = resolve("tests/fixtures/promisify-zlib/long-text.mts");
  const directory = await mkdtemp(join(tmpdir(), "scriptc-promisify-zlib-interop-"));
  try {
    const oracle = primaryOracleExecutable(NODE_COMPAT_MATRIX);
    const node = await runFileStdio(oracle, [entry]);
    expect(node.code).toBe(0);
    expect(node.stderr.toString()).toBe("");
    expect(node.stdout.toString()).toBe("y0jNyclXeDSjOWOUMcognQEA\ntrue\n");
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization: "dev",
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code).toBe(0);
    expect(native.signal).toBeNull();
    expect(native.stderr.toString()).toBe("");
    expect(native.stdout).toEqual(node.stdout);
    const crossDecoded = await runFileStdio(oracle, ["--input-type=module", "-e",
      'import { inflateRawSync } from "node:zlib"; console.log(inflateRawSync(Buffer.from(process.argv[1], "base64")).toString("utf8") === "hello ☃".repeat(64));',
      native.stdout.toString().split("\n")[0] ?? "",
    ]);
    expect(crossDecoded.code).toBe(0);
    expect(crossDecoded.stderr.toString()).toBe("");
    expect(crossDecoded.stdout.toString()).toBe("true\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["dev", "release"] as const)("Rust %s promisified raw zlib rejects options and corrupt data without a synchronous throw", async optimization => {
  await differentialProgram("3396-promisify-zlib-errors.js", [
    "rejected true",
    'RangeError ERR_OUT_OF_RANGE The value of "options.level" is out of range. It must be >= -1 and <= 9. Received 10',
    "rejected true",
    'RangeError ERR_OUT_OF_RANGE The value of "options.level" is out of range. It must be >= -1 and <= 9. Received -2',
    "rejected true",
    'RangeError ERR_OUT_OF_RANGE The value of "options.level" is out of range. It must be a finite number. Received Infinity',
    "rejected true",
    'TypeError ERR_INVALID_ARG_TYPE The "options.level" property must be of type number. Received type string (\'bad\')',
    "rejected true",
    'TypeError ERR_INVALID_ARG_TYPE The "options.level" property must be of type number. Received null',
    "Error Z_BUF_ERROR unexpected end of file",
    "Error Z_DATA_ERROR invalid block type",
    "Error Z_BUF_ERROR unexpected end of file", "",
  ].join("\n"), optimization);
});

test.each([
  ["unsupported-target.ts", "SC2020", "util.promisify of this target"],
  ["escaped.ts", "SC1090", "a promisified zlib function as a value"],
  ["unsupported-option.ts", "SC2020", "promisified deflateRaw options"],
  ["mutable.ts", "SC2020", "a mutable promisified zlib binding"],
] as const)("Rust refuses unqualified promisify shape %s", (file, code, reason) => {
  const { coverage } = analyze(resolve("tests/fixtures/promisify-zlib", file), { backend: "rust", allowEngine: false });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code, message: expect.stringContaining(reason) }));
});
