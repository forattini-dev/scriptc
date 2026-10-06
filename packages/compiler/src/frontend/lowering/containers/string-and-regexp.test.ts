import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../../../index.js";

function coverageOf(source: string, extension: "ts" | "js" = "ts") {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-string-replace-"));
  try {
    const entry = join(directory, `main.${extension}`);
    writeFileSync(entry, source);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// A replacement function is called once per match and a string pattern has no
// lowering for that. It used to reach the string intrinsic and fail the IR
// validator with an internal compiler error instead of a diagnostic.
test.each([
  ["replace", "arrow", `const f = (m: string): string => "X" + m;\nconsole.log("abcb".replace("b", f));`],
  ["replaceAll", "arrow", `const f = (m: string): string => "X" + m;\nconsole.log("abcb".replaceAll("b", f));`],
  ["replace", "inline", `console.log("abcb".replace("b", (m: string): string => "X" + m));`],
  ["replace", "named function", `function up(m: string): string { return m.toUpperCase(); }\nconsole.log("abcb".replace("b", up));`],
  ["replace", "builtin by reference", `console.log("a b".replace(" ", encodeURIComponent));`],
])("a string pattern with a function replacement is a SC1120 diagnostic: %s with %s", (_method, _shape, source) => {
  const coverage = coverageOf(source);
  expect(coverage.diagnostics.map((d) => d.code)).not.toContain("SC9001");
  const fences = coverage.diagnostics.filter((d) => d.code === "SC1120");
  expect(fences).toHaveLength(1);
  expect(fences[0]!.message).toContain("function replacement values");
});

// In a JavaScript source a builtin taken as a value lowers to an opaque
// identity token, a string. It must fence, never interpolate "[builtin ...]".
test.each([
  `console.log("a b".replace(/ /g, encodeURI));`,
  `console.log("a b c".replaceAll(/ /g, encodeURIComponent));`,
  `console.log("a b".replace(" ", encodeURIComponent));`,
  `const f = (m) => "X" + m;\nconsole.log("abcb".replace("b", f));`,
])("a function replacement in a JavaScript source never lowers to a token: %s", (source) => {
  const coverage = coverageOf(source, "js");
  const messages = coverage.diagnostics.map((d) => d.message).join("\n");
  expect(coverage.diagnostics.map((d) => d.code)).not.toContain("SC9001");
  expect(messages).toContain("function replacement values");
});

test("string templates and the one-argument regex callback keep lowering", () => {
  const coverage = coverageOf(`
    console.log("a b b".replace(" ", "_"), "a b b".replaceAll("b", "$&$&"));
    console.log("a b".replace(/ /g, (m: string): string => "[" + m + "]"));
    console.log("a b".replace(/ /g, "-"));
  `);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});
