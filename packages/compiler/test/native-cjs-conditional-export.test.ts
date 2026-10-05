import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, isRuntimeTargetId, NODE_COMPAT_MATRIX } from "../src/index.js";

test.each([
  "3447-cjs-conditional-function/main.ts",
  "3448-cjs-conditional-require/main.cjs",
  "3449-cjs-conditional-export-forwarding/main.ts",
].flatMap(file => ([
  { backend: "rust", optimization: "dev" }, { backend: "rust", optimization: "release" },
  { backend: "c", optimization: "dev" }, { backend: "llvm", optimization: "dev" },
] as const).map(build => ({ file, ...build }))))(
  "$backend $optimization selects CommonJS exports at runtime: $file",
  async ({ file, backend, optimization }) => {
    const target = process.env["SCRIPTC_RUNTIME_TARGET"];
    if (target !== undefined && !isRuntimeTargetId(target)) throw new Error(`invalid target: ${target}`);
    const entry = resolve("tests/corpus", file);
    const directory = await mkdtemp(join(tmpdir(), "scriptc-cjs-conditional-"));
    try {
      const result = await compile(entry, {
        backend, allowEngine: false, optimization,
        sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
        ...(target === undefined ? {} : { target }),
        outDir: directory, outPath: join(directory, "program"),
      });
      expect(result.ok, result.ok ? undefined : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
      if (!result.ok) return;
      expect(result.execution).toEqual({ engine: "none", externalFfi: false });
      expect(result.runtimeFences).toEqual([]);
      for (const args of [[], ["--first"]]) {
        const oracle = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry, ...args]);
        expect(oracle.code, oracle.stderr.toString()).toBe(0);
        expect(oracle.signal).toBeNull();
        const native = await runFileStdio(result.binaryPath, args, { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
        expect(native.code, native.stderr.toString()).toBe(oracle.code);
        expect(native.signal).toBe(oracle.signal);
        expect(native.stdout).toEqual(oracle.stdout);
        expect(native.stderr).toEqual(oracle.stderr);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
);

test.each([
  ["missing else", "if (process.argv.includes('--first')) module.exports = (value) => value + 1;"],
  ["different signatures", "if (process.argv.includes('--first')) module.exports = (value) => value; else module.exports = (value, extra) => extra;"],
  ["callback replacement", "if (process.argv.includes('--first')) module.exports = (value) => value + 1; else module.exports = (value) => value - 1; setTimeout(() => { module.exports = (value) => value + 2; }, 0);"],
  ["loop initialization", "while (process.argv.includes('--first')) { module.exports = (value) => value + 1; break; }"],
] as const)("keeps an explicit refusal for %s", async (_name, source) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-cjs-conditional-refusal-"));
  try {
    const entry = join(directory, "main.ts");
    await writeFile(entry, "import run from './choice.cjs'; console.log(run(7));\n");
    await writeFile(join(directory, "choice.cjs"), "'use strict';\n" + source + "\n");
    const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.code === "SC1090" || d.code === "SC3003"), JSON.stringify(result.diagnostics)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retains the existing refusal for reassigning a require binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-cjs-conditional-mutable-"));
  try {
    const entry = join(directory, "main.cjs");
    await writeFile(entry, "'use strict'; let run = require('./choice.cjs'); const original = require('./choice.cjs'); run = value => value + 10; console.log(run(7), original(7));\n");
    await writeFile(join(directory, "choice.cjs"), "'use strict'; if (process.argv.includes('--first')) module.exports = value => value + 1; else module.exports = value => value - 1;\n");
    const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.code === "SC0001" && d.message.includes("Cannot assign to 'run'")), JSON.stringify(result.diagnostics)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
