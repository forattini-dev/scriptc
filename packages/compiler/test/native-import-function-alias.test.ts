import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(body: string, strict: boolean) {
  const root = mkdtempSync(join(tmpdir(), "scriptc-native-function-alias-"));
  try {
    const entry = join(root, "main.ts");
    writeFileSync(join(root, "module.ts"), `
      export type Row = { count: number };
      export function fresh(row: Row = { count: 0 }): Row { row.count++; return row; }
      export async function later(row: Row = { count: 0 }): Promise<Row> { return fresh(row); }
    `);
    writeFileSync(entry, body + "\nexport {};\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict, strictNullChecks: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowImportingTsExtensions: true, noEmit: true }, files: ["main.ts", "module.ts"] }));
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test.each([true, false])("native function bindings and aliases keep their handle with strict=%s", strict => {
  for (const body of [
    'const { fresh } = await import("./module.ts"); console.log(fresh().count);',
    'async function main() { const { fresh: renamed } = await import("./module.ts"); const alias = renamed; console.log(alias().count); } await main();',
    'const ns = await import("./module.ts"); const nsAlias = ns; const { fresh } = nsAlias; const first = fresh; const second = first; console.log(second().count);',
    'const ns = await import("./module.ts"); const fn = ns.fresh; console.log(fn().count);',
    'const ns = await import("./module.ts"); const fn = ns["fresh"]; console.log(fn().count);',
    'async function main() { const { fresh } = await import("./module.ts"); let fn = fresh; fn = fresh; console.log(fn({ count: 3 }).count); } await main();',
    'async function main() { const { fresh } = await import("./module.ts"); var fn = fresh; console.log(fn().count); } await main();',
    'const { fresh } = await import("./module.ts"); function invoke() { return fresh().count; } console.log(invoke());',
    'const ns = await import("./module.ts"); const fn: typeof ns.fresh = ns.fresh; console.log(fn().count);',
    'const { fresh } = await import("./module.ts"); const fn = ((fresh as typeof fresh)!); console.log(fn().count);',
    'const { fresh } = await import("./module.ts"); const fn = fresh satisfies typeof fresh; console.log(fn().count);',
    'await import("./module.ts").then(ns => { const { fresh } = ns; const alias = fresh; console.log(alias().count); });',
    'const { later: run } = await import("./module.ts"); const alias = run; const row = await alias(); console.log(row.count);',
  ]) {
    const coverage = coverageOf(body, strict);
    expect(coverage.preflightFailed, body).toBe(false);
    expect(coverage.diagnostics, body).toEqual([]);
    expect(coverage.execution?.engine, body).toBe("none");
  }
});

test("long callable alias chains retain native storage without recursive provenance walking", () => {
  const aliases = Array.from({ length: 128 }, (_, index) => `const alias${index} = ${index === 0 ? "fresh" : `alias${index - 1}`};`).join("\n");
  const coverage = coverageOf(`const { fresh } = await import("./module.ts"); ${aliases} console.log(alias127().count);`, true);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution?.engine).toBe("none");
});

test("native callable provenance does not remove the namespace copy boundary", () => {
  const coverage = coverageOf('function read(value: { fresh: (row?: { count: number }) => { count: number } }): void { console.log(typeof value); } const ns = await import("./module.ts"); read(ns);', true);
  expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code: "SC1090", message: expect.stringContaining("namespace conversion") }));
});
