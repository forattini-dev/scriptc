import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function inspect(source: string, target: "node24" | "node26" | "bun" = "node24") {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-capabilities-"));
  const entry = join(dir, "main.mjs");
  writeFileSync(entry, source);
  try { return analyze(entry, { target, backend: "rust", allowEngine: false }).coverage; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test.each(["node24", "node26", "bun"] as const)("SDK capability guards lower for %s", (target) => {
  const coverage = inspect(`
    const isBun = typeof globalThis.Bun !== 'undefined' && typeof globalThis.Bun.spawn === 'function';
    const isDeno = typeof globalThis.Deno !== 'undefined' && typeof globalThis.Deno.Command === 'function';
    console.log(isBun, isDeno);
  `, target);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsIsland).toBe(0);
});

test.each([
  "globalThis.Bun = { spawn: 1 };",
  "globalThis.Deno = { Command: 1 };",
  "delete globalThis.Bun;",
  "Object.defineProperty(globalThis, 'Bun', { get() { return 42; } });",
  "const root = globalThis; root.Bun = 42;",
  "globalThis.Bun.spawn = 1;",
])("global mutation retains a native refusal: %s", (write) => {
  const coverage = inspect(`${write}\nconsole.log(typeof globalThis.Bun, typeof globalThis.Deno);`, "bun");
  expect(coverage.diagnostics.length).toBeGreaterThan(0);
  expect(coverage.stats.statementsIsland).toBe(0);
});

test("a successful capability probe does not implement Bun.spawn", () => {
  const coverage = inspect(`
    if (typeof globalThis.Bun !== 'undefined' && typeof globalThis.Bun.spawn === 'function') {
      globalThis.Bun.spawn(['echo', 'hello']);
    }
  `, "bun");
  expect(coverage.diagnostics.length).toBeGreaterThan(0);
  expect(coverage.stats.statementsIsland).toBe(0);
});

test("unguarded absent members cannot become successful function probes", () => {
  expect(inspect("console.log(typeof globalThis.Bun.spawn);").diagnostics.length).toBeGreaterThan(0);
  expect(inspect("console.log(typeof globalThis.Deno.Command);", "bun").diagnostics.length).toBeGreaterThan(0);
});
