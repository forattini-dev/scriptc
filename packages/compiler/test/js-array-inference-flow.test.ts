import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(source: string, extension = "js") {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-js-array-flow-"));
  try {
    const entry = join(dir, `main.${extension}`);
    writeFileSync(join(dir, "source.js"), `export function parse() {
  const result = { errors: [] };
  result.errors.push("bad");
  return result;
}`);
    writeFileSync(entry, 'import { parse } from "./source.js";\n' + source);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test.each(["find", "findLast"])("%s keeps inferred JS values through callbacks and local result guards", method => {
  const coverage = coverageOf(`function run() {
  const errors = parse().errors;
  const found = errors.${method}(error => /^bad/.test(error));
  if (found !== undefined) console.log(found.replace(/^b/, "B"));
} run();`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.runtimeFences ?? []).toEqual([]);
});

test("a declared TS numeric alias keeps its element contract", () => {
  const coverage = coverageOf('const values: number[] = parse().errors; values.push("wrong");', "ts");
  expect(coverage.diagnostics.some(d => d.message.includes("number") && d.message.includes("string"))).toBe(true);
});

test("unrelated TS never arrays do not acquire a dynamic fallback through aliases", () => {
  const coverage = coverageOf('const values: never[] = []; const alias = values; const wrapped = { alias }; wrapped.alias.push("wrong");', "ts");
  expect(coverage.diagnostics.length).toBeGreaterThan(0);
  expect(coverage.preflightFailed).toBe(true);
});
