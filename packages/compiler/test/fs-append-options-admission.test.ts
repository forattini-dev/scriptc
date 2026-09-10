import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageFor(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-append-options-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, `import { appendFileSync } from "node:fs";\n${source}`);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each([
  '{ encoding: "utf8", mode: 0o600 }',
  '{ flag: "a" }',
  '{ flag: "ax" }',
  '"utf-8"',
])("admits native string append options: %s", options => {
  const coverage = coverageFor(`appendFileSync("spool", "row", ${options});`);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution?.engine).toBe("none");
});

test.each([
  ['{ flush: true }', "flush"],
  ['{ flag: "w" }', "flag"],
  ['{ flag: "as" }', "flag"],
  ['{ ignored: console.log("must evaluate") }', "effectful value"],
])("refuses unsupported append behavior: %s", (options, message) => {
  const coverage = coverageFor(`appendFileSync("spool", "row", ${options});`);
  expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
  expect(coverage.diagnostics.some(d => d.code === "SC2020" && d.message.includes(message)),
    JSON.stringify(coverage.diagnostics)).toBe(true);
  expect(coverage.execution).toBeUndefined();
});

test("refuses a variable options record instead of discarding its values", () => {
  const coverage = coverageFor('const options = { mode: 0o600 }; appendFileSync("spool", "row", options);');
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.some(d => d.code === "SC2020" && d.message.includes("3 arguments"))).toBe(true);
});

test("fallback types reject non-UTF-8 append encoding", () => {
  const coverage = coverageFor('appendFileSync("spool", "row", { encoding: "hex" });');
  expect(coverage.preflightFailed).toBe(true);
  expect(coverage.diagnostics.some(d => d.code === "SC0001")).toBe(true);
});
