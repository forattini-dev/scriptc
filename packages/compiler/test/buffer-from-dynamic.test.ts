import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

async function differentialProgram(file: string, stdout: string, optimization: "dev" | "release") {
  const entry = resolve("tests/corpus", file);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-buffer-from-dynamic-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.signal).toBeNull();
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

async function runtimeRefusal(file: string, stderr: string, optimization: "dev" | "release") {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-buffer-from-refusal-"));
  try {
    const result = await compile(resolve("tests/fixtures/buffer-from-dynamic", file), {
      backend: "rust", allowEngine: false, optimization, outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code).toBe(1);
    expect(native.signal).toBeNull();
    expect(native.stdout.toString()).toBe("");
    expect(native.stderr.toString()).toBe(stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test.each(["c", "llvm"] as const)("%s keeps a named refusal for the Rust-only checked Buffer.from call", async backend => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-buffer-backend-refusal-"));
  try {
    const result = await compile(resolve("tests/corpus/3397-buffer-from-dynamic-string.js"), {
      backend, allowEngine: false, outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("SC3001");
    expect(result.diagnostics[0]?.message).toContain("buffer.fromDyn");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

describe.each(["dev", "release"] as const)("native Buffer.from (%s)", optimization => {
  test("Rust Buffer.from UTF-8 encodes a native dynamic string", async () => {
    await differentialProgram("3397-buffer-from-dynamic-string.js", "68656c6c6f20e29883\n\n", optimization);
  });

  test("Rust Buffer.from validates invalid native dynamic inputs with Node error shapes", async () => {
    const prefix = "TypeError ERR_INVALID_ARG_TYPE The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received ";
    await differentialProgram("3398-buffer-from-dynamic-errors.js", [
      "null", "type number (42)", "type boolean (true)", "an instance of Object", "undefined",
    ].map(value => prefix + value + "\n").join(""), optimization);
  });

  test("Rust Buffer.from copies native dynamic buffers and offset views without aliasing", async () => {
    await differentialProgram("3399-buffer-from-dynamic-copy.js", "01ff03\n07ff03 010203\n0405\n", optimization);
  });

  test("Rust Buffer.from coerces native dynamic array elements to bytes", async () => {
    await differentialProgram("3400-buffer-from-dynamic-array.js", "01ff03010002000005000000\n\nTypeError Cannot convert a BigInt value to a number\nTypeError Cannot convert a Symbol value to a number\n", optimization);
  });

  test("Rust Buffer.from handles native dynamic array-like and serialized Buffer objects", async () => {
    await differentialProgram("3401-buffer-from-dynamic-arraylike.js", "01ff0005\n07\n\n\n030507\n\nRangeError Array buffer allocation failed\n", optimization);
  });

  test("Rust retains the explicit non-u8 typed-array dynamic-boundary refusal", async () => {
    const result = await compile(resolve("tests/fixtures/buffer-from-dynamic/typed-refusal.js"), {
      backend: "rust", allowEngine: false, optimization,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every(diagnostic => diagnostic.code === "SC3003" &&
      diagnostic.message.includes("[SC1101] converting typed values to 'unknown'"))).toBe(true);
  });

  test("Rust Buffer.from observes native valueOf with bound this and recursive accepted values", async () => {
    await differentialProgram("3402-buffer-from-dynamic-valueof.js", "cf80\n01ff\n09\n07\n05\nTypeError value.valueOf is not a function\n", optimization);
  });

  test("Rust Buffer.from applies literal encodings to native dynamic strings", async () => {
    await differentialProgram("3403-buffer-from-dynamic-encodings.js", "abcd\nhello\nffc0\n0326\n", optimization);
  });

  test("Rust Buffer.from honors an array's own valueOf before copying numeric elements", async () => {
    await differentialProgram("3404-buffer-from-dynamic-array-valueof.js", "616263\n0102\nError conversion stopped\n", optimization);
  });

  test("Rust retains the explicit dynamic accessor-descriptor runtime refusal", async () => {
    await runtimeRefusal("getter-refusal.js", "Uncaught Error: accessor (get/set) property descriptors on a dynamic value are not supported yet\n", optimization);
  });

  test("Rust explicitly refuses Buffer.from Proxy conversion instead of misclassifying a valid input", async () => {
    await runtimeRefusal("proxy-refusal.js", "Uncaught Error: scriptc: Buffer.from on native Proxy objects is not supported yet\n", optimization);
  });

  test("Rust explicitly bounds recursive Buffer.from valueOf conversion", async () => {
    await runtimeRefusal("recursive-refusal.js", "Uncaught Error: scriptc: Buffer.from valueOf conversion beyond 128 levels is not supported yet\n", optimization);
  });

  test("Rust preserves the explicit typed-prototype construction refusal before Buffer.from", async () => {
    const result = await compile(resolve("tests/fixtures/buffer-from-dynamic/inherited-coercion-refusal.js"), {
      backend: "rust", allowEngine: false, optimization,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("SC3003");
    expect(result.diagnostics[0]?.message).toContain("[SC2020] 'Object.create over");
  });
});
