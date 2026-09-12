import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

async function fixture(run: (dir: string, entry: string, pkg: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-context-"));
  const pkg = join(dir, "node_modules", "rows-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "rows-sdk", type: "module", main: "index.js", types: "index.d.ts",
  }));
  // The declarations intentionally lie about one row's scalar type. They
  // may contextualize the consumer, but cannot determine native values.
  writeFileSync(join(pkg, "index.js"), `export function rows() {
  return JSON.parse('[{"value":"actual"},{"value":7}]');
}\n`);
  writeFileSync(join(pkg, "index.d.ts"), "export function rows(): { value: number }[];\n");
  const entry = join(dir, "main.ts");
  writeFileSync(entry, `import { rows } from "rows-sdk";
console.log(JSON.stringify(rows().map(row => row.value)));
console.error("contextual callbacks");\n`);
  try { await run(dir, entry, pkg); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test.each(["auto", "explicit"])("%s admission preserves callbacks typed by published declarations", async (mode) => {
  await fixture((_, entry) => {
    const { coverage } = analyze(entry, {
      npmStatic: mode === "auto" ? "auto" : ["rows-sdk"], backend: "rust", allowEngine: false,
    });
    expect(coverage.npmStatic).toEqual([{ package: "rows-sdk", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.stats.statementsIsland).toBe(0);
  });
});

const backends = (["rust", "c", "llvm"] as const).filter((b) => b !== "rust" || process.env["SCRIPTC_SAN"] !== "1");
test.for(backends)("contextual callbacks preserve runtime values with %s", async (backend) => {
  await fixture(async (dir, entry) => {
    const result = await compile(entry, { backend, npmStatic: "auto", allowEngine: false,
      outDir: join(dir, "out"), outPath: join(dir, "out/program"), optimization: "dev",
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, result.ok ? "" : result.diagnostics.map((d) => d.message).join("\n")).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    expect(result.runtimeFences).toEqual([]);
    const node = spawnSync(nodeOracleExecutable(), [entry], { timeout: 30_000 });
    const native = spawnSync(result.binaryPath, [], { timeout: 30_000 });
    expect(node.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    expect(node.status).toBe(0);
    expect(native.signal).toBeNull();
    expect(native.status).toBe(node.status);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
    expect(native.stdout.toString()).toContain('["actual",7]');
  });
});

test("destructured callback parameters reach native lowering without trusting declared fields", async () => {
  await fixture((_, entry) => {
    writeFileSync(entry, `import { rows } from "rows-sdk";
console.log(rows().map(({ value }) => value));\n`);
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.npmStatic).toEqual([{ package: "rows-sdk", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    // This any-containing record is still outside native shape lowering.
    // Passing authoring preflight must not erase that runtime boundary.
    expect(coverage.diagnostics.some((d) => d.code === "SC2009" && d.message.includes("member 'value' has type 'any'"))).toBe(true);
    expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(false);
  });
});

test("an originally untyped callback still fails the strict TypeScript gate", async () => {
  await fixture((_, entry, pkg) => {
    writeFileSync(join(pkg, "index.d.ts"), "export function rows(): any;\n");
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(true);
    expect(coverage.diagnostics.some((d) => d.code === "SC0001" && d.message.includes("implicitly has an 'any' type"))).toBe(true);
    expect(coverage.npmStatic?.some((p) => p.status === "static")).toBe(false);
  });
});

test("unrelated consumer type errors do not acquire an exception", async () => {
  await fixture((_, entry) => {
    writeFileSync(entry, `import { rows } from "rows-sdk";
const broken: number = "wrong";
console.log(rows().map(row => row.value), broken);\n`);
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(true);
    expect(coverage.diagnostics.some((d) => d.code === "SC0001" && d.message.includes("not assignable"))).toBe(true);
  });
});

test("the original declaration view must also reject invalid callback bodies", async () => {
  await fixture((_, entry) => {
    // Native inference loses both the parameter context and this number
    // member error. Only checking the native diagnostic list would hide it.
    writeFileSync(entry, `import { rows } from "rows-sdk";
console.log(rows().map(row => row.value.toUpperCase()));\n`);
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(true);
    expect(coverage.diagnostics.some((d) => d.code === "SC0001" && d.message.includes("toUpperCase"))).toBe(true);
  });
});

test("implicit parameters outside callbacks retain the strict gate", async () => {
  await fixture((_, entry) => {
    writeFileSync(entry, `import { rows } from "rows-sdk";
function untyped(value) { return value; }
console.log(rows().map(row => row.value), untyped(1));\n`);
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(true);
    expect(coverage.diagnostics.some((d) => d.code === "SC0001" && d.message.includes("Parameter 'value'"))).toBe(true);
  });
});

test("an inferred value-signature disagreement still falls back", async () => {
  await fixture((_, entry, pkg) => {
    writeFileSync(join(pkg, "index.js"), 'export function rows() {\n  return "runtime";\n}\n');
    writeFileSync(entry, `import { rows } from "rows-sdk";
const values: { value: number }[] = rows();
console.log(values.length);\n`);
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.npmStatic?.some((p) => p.status === "fallback")).toBe(true);
    expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(true);
  });
});

test("a later flagless compile retains its ordinary npm engine boundary", async () => {
  await fixture((_, entry) => {
    const native = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(native.coverage.diagnostics).toEqual([]);
    const ordinary = analyze(entry, { backend: "rust", allowEngine: false });
    expect(ordinary.coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(true);
  });
});

test.for(backends)("a changed declaration invalidates prior callback admission with %s", async (backend) => {
  await fixture(async (dir, entry, pkg) => {
    // This checks declaration invalidation before code generation. Dev mode
    // keeps the native prerequisite small while covering every backend.
    const options = { backend, optimization: "dev" as const, npmStatic: "auto" as const, allowEngine: false,
      outDir: join(dir, "out"), outPath: join(dir, "out/program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    };
    const before = await compile(entry, options);
    expect(before.ok).toBe(true);
    writeFileSync(join(pkg, "index.d.ts"), "export function rows(): any;\n");
    const after = await compile(entry, options);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.diagnostics.some((d) =>
      d.code === "SC0001" && d.message.includes("implicitly has an 'any' type"))).toBe(true);
  });
});
