import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";
import { compileRust } from "../src/backend/rust/compile.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-no-engine-"));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

test("Rust analysis accepts checked dynamic values without an engine", () => {
  const dir = fixture({ "main.ts": 'const value: unknown = JSON.parse("42"); console.log(typeof value);' });
  const { coverage } = analyze(join(dir, "main.ts"), { backend: "rust", dynamic: true, allowEngine: false });
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution).toEqual({ engine: "none", externalFfi: false });
});

test("the default Rust backend keeps dynamic hello-world engine-free", () => {
  const entry = resolve("tests/corpus/001-hello.ts");
  const { coverage } = analyze(entry, { dynamic: true, allowEngine: false });
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution).toEqual({ engine: "none", externalFfi: false });
});

test("explicit engine evaluation is refused by analysis and build before writing artifacts", async () => {
  const dir = fixture({ "main.ts": 'console.log(__island_eval("1 + 2"));' });
  const entry = join(dir, "main.ts");
  const options = { backend: "rust" as const, dynamic: true, allowEngine: false };
  const { coverage } = analyze(entry, options);
  expect(coverage.diagnostics.some((d) => d.code === "SC3003" && d.message.includes("island.eval"))).toBe(true);
  const outDir = join(dir, "out");
  const result = await compile(entry, { ...options, outDir, outPath: join(outDir, "main") });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostics).toEqual(coverage.diagnostics);
  expect(existsSync(outDir)).toBe(false);
});

test.each(["isInteger", "isSafeInteger"])("native Number.%s still rejects engine use in its argument", (method) => {
  const dir = fixture({ "main.ts": `console.log(Number.${method}(__island_eval("42") as any));` });
  const { coverage } = analyze(join(dir, "main.ts"), { backend: "rust", dynamic: true, allowEngine: false });
  expect(coverage.diagnostics.some(d => d.code === "SC3003" && d.message.includes("island.eval")), JSON.stringify(coverage.diagnostics)).toBe(true);
});

test("persisted island pins cannot bypass --no-engine", async () => {
  const dir = fixture({
    "package.json": '{"type":"module"}',
    "scriptc.json": '{"tiers":{"island":["dep.ts"]}}',
    "main.ts": 'import { answer } from "./dep.ts"; console.log(answer());',
    "dep.ts": 'export function answer(): number { return 42; }',
  });
  const entry = join(dir, "main.ts");
  const options = { backend: "rust" as const, dynamic: true };
  const normal = analyze(entry, options).coverage;
  expect(normal.diagnostics).toEqual([]);
  expect(["boa", "v8"]).toContain(normal.execution?.engine);
  const denied = analyze(entry, { ...options, allowEngine: false }).coverage;
  expect(denied.diagnostics.some((d) => d.code === "SC3003" && d.message.includes("dep.ts"))).toBe(true);
  const result = await compile(entry, { ...options, allowEngine: false, outDir: join(dir, "out"), outPath: join(dir, "out/main") });
  expect(result.ok).toBe(false);
  expect(existsSync(join(dir, "out"))).toBe(false);
});

test("QuickJS cannot be admitted through the C or LLVM backend", () => {
  const entry = resolve("tests/corpus/001-hello.ts");
  for (const backend of ["c", "llvm"] as const) {
    const { coverage } = analyze(entry, { backend, dynamic: true, allowEngine: false });
    expect(coverage.diagnostics.some((d) => d.code === "SC3003")).toBe(true);
  }
});

test("deferred runtime refusals fail native admission at the original source location", async () => {
  const entry = resolve("packages/compiler/test/fixtures/runtime-target/src/sqlite.ts");
  const options = { target: "bun" as const, dynamic: true, backend: "rust" as const };
  const ordinary = analyze(entry, options).coverage;
  expect(ordinary.runtimeFences).toHaveLength(1);
  const denied = analyze(entry, { ...options, allowEngine: false }).coverage;
  expect(denied.diagnostics).toHaveLength(1);
  expect(denied.diagnostics[0]?.code).toBe("SC3003");
  expect(denied.diagnostics[0]?.message).toContain("deferred unsupported functionality");
  expect(denied.diagnostics[0]?.loc).toEqual(ordinary.runtimeFences?.[0]?.loc);
  const dir = fixture({});
  const outDir = join(dir, "out");
  const result = await compile(entry, { ...options, allowEngine: false, outDir, outPath: join(outDir, "main") });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostics).toEqual(denied.diagnostics);
  expect(existsSync(outDir)).toBe(false);
});

test.each(["island-v8", "island-eval"] as const)("Cargo admission rejects %s before reading source or starting a toolchain", async (feature) => {
  const dir = fixture({});
  await expect(compileRust({ sourcePath: join(dir, "missing.rs"), outPath: join(dir, "out"), runtimeFeatures: [feature], allowEngine: false })).rejects.toThrow("--no-engine forbids JavaScript engine runtime features");
  expect(existsSync(join(dir, "out"))).toBe(false);
});
