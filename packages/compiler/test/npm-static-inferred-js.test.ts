import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "../src/type-acquisition/fixtures.js";
import { analyze, compile, isRuntimeTargetId, NODE_COMPAT_MATRIX } from "../src/index.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";

const cases = [
  { name: "ESM inferred returns", file: "index.js", source: "export function answer() { return 42; }\nexport const label = 'inferred';\n",
    entry: "import { answer, label } from 'type-example'; console.log(answer(), label);\n" },
  { name: "CommonJS conditional closures", file: "index.cjs", source: "'use strict';\nif (process.argv.includes('--first')) { let offset = 1; module.exports = function answer(value) { return value + offset++; }; } else { let offset = 1; module.exports = function answer(value) { return value + -(offset++); }; }\n",
    entry: "import answer from 'type-example'; console.log(answer(7), answer(7));\n" },
] as const;

function installed(program: { file: string; source: string; entry: string }): string {
  return fixture({
    // npm package.json is an external JSON protocol, not owned state.
    "node_modules/type-example/package.json": `{"name":"type-example","version":"1.2.0","type":"module","main":"${program.file}"}`,
    "node_modules/type-example/index.js": program.source,
    [`node_modules/type-example/${program.file}`]: program.source,
    "main.ts": program.entry,
  });
}

test.each(cases)("AUTO infers readable JS without a declaration surface: $name", ({ ...program }) => {
  const root = installed(program);
  const result = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: "auto" });
  expect(result.coverage.npmStatic).toEqual([{ package: "type-example", status: "static" }]);
  expect(result.coverage.preflightFailed).toBe(false);
  expect(result.coverage.diagnostics).toEqual([]);
  expect(result.coverage.stats.statementsFailed).toBe(0);
});

test("AUTO discovers runtime-only subpaths and transitive CommonJS dependencies", () => {
  const root = fixture({
    "main.ts": "import { answer } from 'type-example/value'; console.log(answer());\n",
    "node_modules/type-example/package.json": '{"name":"type-example","version":"1.2.0","type":"module","exports":{"./value":"./value.js"}}',
    "node_modules/type-example/value.js": "import { base } from 'child';\nexport function answer() { return base() + 1; }\n",
    "node_modules/type-example/node_modules/child/package.json": '{"name":"child","version":"1.0.0","main":"index.cjs"}',
    "node_modules/type-example/node_modules/child/index.cjs": "exports.base = function () { return 41; };\n",
  });
  const { coverage } = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: "auto" });
  expect(coverage.npmStatic).toEqual(expect.arrayContaining([
    { package: "type-example", status: "static" }, { package: "child", status: "static" },
  ]));
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test("AUTO does not trust a consumer's annotation over inferred JS returns", () => {
  const root = installed({ ...cases[0], source: "export function answer() { return 'text'; }\n",
    entry: "import { answer } from 'type-example'; const value: number = answer(); console.log(value);\n" });
  const { coverage } = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: "auto" });
  expect(coverage.npmStatic).toEqual([{ package: "type-example", status: "fallback", detail: expect.stringContaining("inferred surface") }]);
  expect(coverage.preflightFailed).toBe(true);
  expect(coverage.diagnostics.some(d => d.code === "SC0001")).toBe(true);
  const explicit = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: ["type-example"] }).coverage;
  expect(explicit.preflightFailed).toBe(true);
});

test("AUTO admission cannot make unsupported JS into a no-engine build", async () => {
  const root = installed({ ...cases[0], source: "export function answer() { return eval('42'); }\n",
    entry: "import { answer } from 'type-example'; console.log(answer());\n" });
  const result = await compile(join(root, "main.ts"), { backend: "rust", allowEngine: false,
    npmStatic: "auto", outputKind: "rust", outDir: join(root, "out") });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostics.some(d => d.code === "SC3003"), JSON.stringify(result.diagnostics)).toBe(true);
});

test.each(cases)("AUTO native Rust preserves JS inference at runtime: $name", async ({ ...program }) => {
  const root = installed(program);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-inferred-js-native-"));
  const target = process.env["SCRIPTC_RUNTIME_TARGET"];
  if (target !== undefined && !isRuntimeTargetId(target)) throw new Error(`invalid runtime target: ${target}`);
  const entry = join(root, "main.ts");
  try {
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, npmStatic: "auto", optimization: "dev",
      ...(target === undefined ? {} : { target }), outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    for (const args of [[], ["--first"]]) {
      const oracle = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry, ...args]);
      expect(oracle.code, oracle.stderr.toString()).toBe(0);
      expect(oracle.stdout.length).toBeGreaterThan(0);
      const native = await runFileStdio(result.binaryPath, args, { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
      expect(native.code, native.stderr.toString()).toBe(oracle.code);
      expect(native.signal).toBe(oracle.signal);
      expect(native.stdout).toEqual(oracle.stdout);
      expect(native.stderr).toEqual(oracle.stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
