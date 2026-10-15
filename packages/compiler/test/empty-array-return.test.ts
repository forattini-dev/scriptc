import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(body: string, backend: "rust" | "c" | "llvm", strict = true) {
  const root = mkdtempSync(join(tmpdir(), "scriptc-empty-array-return-"));
  try {
    const entry = join(root, "main.ts");
    writeFileSync(entry, 'type Row = { id: string; reason: string };\n' + body + '\nexport {};');
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict, strictNullChecks: true, noUncheckedIndexedAccess: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, files: ["main.ts"] }));
    return analyze(entry, { backend, allowEngine: false }).coverage;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test.each([true, false])("Rust contextualizes empty return literals with strict=%s", strict => {
  for (const body of [
    'async function rows(): Promise<Row[]> { return []; } console.log((await rows()).length);',
    'async function rows(skip: boolean): Promise<Row[]> { if (skip) return []; return [{ id: "node", reason: "selected" }]; } console.log((await rows(true)).length);',
    'async function rows(skip: boolean): Promise<Row[] | null> { if (skip) return null; return []; } const result = await rows(false); console.log(result?.length);',
    'async function rows(): Promise<readonly Row[]> { return (([])); } console.log((await rows()).length);',
    'async function rows(): Promise<Row[][]> { return []; } console.log((await rows()).length);',
    'async function rows(): Promise<Row[][]> { return [[], []]; } console.log((await rows()).length);',
    'async function rows<T>(): Promise<T[]> { return []; } const result = await rows<Row>(); console.log(result.length);',
    'const rows = async (): Promise<Row[]> => []; console.log((await rows()).length);',
    'async function rows(): Promise<Row[]> { try { return []; } finally { console.log("finally"); } } console.log((await rows()).length);',
    'async function rows(flag: boolean): Promise<Row[]> { return flag ? [] : []; } console.log((await rows(true)).length);',
  ]) {
    const coverage = coverageOf(body, "rust", strict);
    expect(coverage.preflightFailed, body).toBe(false);
    expect(coverage.diagnostics, body).toEqual([]);
    expect(coverage.execution?.engine, body).toBe("none");
  }
});

test.each(["c", "llvm"] as const)("%s admits the same fresh empty literal coercion", backend => {
  const coverage = coverageOf('async function rows(): Promise<Row[]> { return []; } console.log((await rows()).length);', backend);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution?.engine).toBe("none");
});
