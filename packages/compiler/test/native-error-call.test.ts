import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, isRuntimeTargetId, NODE_COMPAT_MATRIX } from "../src/index.js";

const programs = ["3444-builtin-error-calls.ts", "3445-builtin-error-call-causes.cjs", "3446-builtin-error-call-shadowing.ts"];

async function differentialProgram(file: string, backend: "rust" | "c" | "llvm", optimization: "dev" | "release") {
  const target = process.env["SCRIPTC_RUNTIME_TARGET"];
  if (target !== undefined && !isRuntimeTargetId(target)) throw new Error(`invalid test runtime target: ${target}`);
  const entry = resolve("tests/corpus", file);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-error-call-"));
  try {
    const oracle = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(oracle.code, oracle.stderr.toString()).toBe(0);
    expect(oracle.signal).toBeNull();
    expect(oracle.stderr.toString()).toBe("");
    const result = await compile(entry, {
      backend, allowEngine: false, optimization,
      ...(target === undefined ? {} : { target }),
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(oracle.code);
    expect(native.signal).toBe(oracle.signal);
    expect(native.stdout).toEqual(oracle.stdout);
    expect(native.stderr).toEqual(oracle.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test.each(programs.flatMap(file => (["dev", "release"] as const).map(optimization => ({ file, optimization }))))(
  "Rust $optimization preserves callable builtin Error constructors: $file",
  async ({ file, optimization }) => { await differentialProgram(file, "rust", optimization); },
);

test.each(programs.flatMap(file => (["c", "llvm"] as const).map(backend => ({ file, backend }))))(
  "$backend preserves callable builtin Error constructors: $file",
  async ({ file, backend }) => { await differentialProgram(file, backend, "dev"); },
);

test.each(["3030-error-message-order.js", "3028-error-optional-message.ts", "2723-error-options-cause.ts", "2751-error-options-custom-cause.ts"])("Rust retains new-Error behavior: %s", async file => {
  await differentialProgram(file, "rust", "dev");
});

test.each([
  ["DOMException", "DOMException('bad')"],
  ["user class", "class TypeError { constructor(message) { this.message = message; } }\nTypeError('bad')"],
  ["non-inline options", "const options = { cause: 1 };\nTypeError('bad', options)"],
] as const)("does not extend Error-call admission to %s", async (_name, source) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-error-call-refusal-"));
  const entry = join(directory, "main.cjs");
  try {
    await writeFile(entry, source + ";\n");
    const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory });
    expect(result.ok).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
