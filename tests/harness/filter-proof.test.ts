import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile, renderDiagnostics } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

test.for(["3255-proven-undefined-filter.ts", "3256-nullish-comparison-effects.ts"])("nullish proof %s retains Node behavior in engine-free Rust", async file => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-filter-proof-"));
  try {
    const entry = join(import.meta.dirname, "../corpus", file);
    const result = await compile(entry, { backend: "rust", allowEngine: false,
      optimization: "dev", outDir: dir, outPath: join(dir, "program") });
    expect(result.ok, result.ok ? "" : renderDiagnostics(result.diagnostics, result.sourceTexts, { color: false })).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    expect(result.runtimeFences).toEqual([]);
    const oracle = spawnSync(nodeOracleExecutable(), [entry], { timeout: 30_000 });
    const native = spawnSync(result.binaryPath, [], { timeout: 30_000,
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
    expect(oracle.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    expect(oracle.status).toBe(0);
    expect(native.status).toBe(oracle.status);
    expect(native.signal).toBeNull();
    expect(native.stdout).toEqual(oracle.stdout);
    expect(native.stderr).toEqual(oracle.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const refused = [
  ["lying retained number", 'const xs: (string | number | undefined)[] = [1, undefined]; console.log(xs.filter((value): value is string => value !== undefined).length);'],
  ["strict comparison retains null", 'const xs: (string | null | undefined)[] = [null, undefined]; console.log(xs.filter((value): value is string => value !== undefined).length);'],
  ["strict null comparison retains undefined", 'const xs: (string | null | undefined)[] = [null, undefined]; console.log(xs.filter((value): value is string => value !== null).length);'],
  ["shadowed undefined", 'function run(undefined: string): number { const xs: (string | undefined)[] = ["x", void 0]; return xs.filter((value): value is string => value !== undefined).length; } console.log(run("x"));'],
  ["wrong binding", 'const other: string | undefined = "x"; const xs: (string | undefined)[] = [undefined]; console.log(xs.filter((value): value is string => other !== undefined).length);'],
  ["mutated parameter", 'const xs: (string | undefined)[] = [undefined]; console.log(xs.filter((value): value is string => { value = "x"; return value !== undefined; }).length);'],
] as const;

test.for(refused)("unproven filter refuses: %s", ([, source]) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-filter-refusal-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics.some(d => d.code === "SC1090" && d.message.includes("hand-written type predicate")),
      coverage.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    expect(coverage.diagnostics.some(d => d.code === "SC0001" || d.code === "SC9001")).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
