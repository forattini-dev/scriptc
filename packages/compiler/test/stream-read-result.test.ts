import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test("Bun default-reader result aliases retain native done/value projections", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-default-reader-"));
  try {
    const types = join(dir, "node_modules/@types/node");
    mkdirSync(types, { recursive: true });
    writeFileSync(join(types, "package.json"), '{"name":"@types/node","types":"index.d.ts"}');
    writeFileSync(join(types, "index.d.ts"), `
      interface ReadableStreamDefaultReadDoneResult { done: true; value?: undefined; }
      interface ReadableStreamDefaultReadValueResult<T> { done: false; value: T; }
      type ReadableStreamDefaultReadResult<T> = ReadableStreamDefaultReadDoneResult | ReadableStreamDefaultReadValueResult<T>;
    `);
    writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true,"types":["node"]}}');
    const entry = join(dir, "main.ts");
    writeFileSync(entry, `
      function size(result: ReadableStreamDefaultReadResult<Uint8Array>): number {
        if (result.done) return 0;
        return result.value.byteLength;
      }
      size({ done: false, value: new Uint8Array([1, 2]) });
    `);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
