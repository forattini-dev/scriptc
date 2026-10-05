import { expect, test } from "vitest";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { renderCoverage, type CoverageInput } from "./report.js";

const stats = (total: number, failed: number) => ({ statementsTotal: total, statementsFailed: failed, statementsIsland: 0, functionsSkipped: 0 });
const fence = (code: ScrDiagnostic["code"], message: string, start = 0): ScrDiagnostic => ({ code, message, loc: { file: "main.js", start, end: start + 1 } });

const base: CoverageInput = {
  file: "main.js",
  stats: stats(4, 0),
  diagnostics: [],
  preflightFailed: false,
};

test("the unreached remainder's deferred fences render in their own dimmed group", () => {
  const out = renderCoverage({
    ...base,
    stats: stats(2, 0),
    unreached: {
      stats: stats(2, 2),
      diagnostics: [],
      runtimeFences: [
        fence("SC1090", "'string' values where '(string) => string' is expected is not supported yet", 10),
        fence("SC2004", "uses of 'ext' inherit the blocker on its declaration", 20),
        fence("SC2004", "uses of 'ext' inherit the blocker on its declaration", 30),
      ],
    },
  });
  expect(out).toContain("statements analyzed   4");
  expect(out).toContain("compile statically    2  (50%)");
  expect(out).toContain("deferred in unreached code   3 sites (never lowered — JS statements that would throw their fence if reached)");
  expect(out).toContain("×2  uses of 'ext' inherit the blocker on its declaration");
  expect(out).toContain("×1  'string' values where '(string) => string' is expected  SC1090");
  // Unreached fences never join the reached "deferred to runtime" group.
  expect(out).not.toContain("deferred to runtime ");
});

test("without unreached fences the report is unchanged", () => {
  const withoutField = renderCoverage({ ...base, unreached: { stats: stats(0, 0), diagnostics: [] } });
  const withEmpty = renderCoverage({ ...base, unreached: { stats: stats(0, 0), diagnostics: [], runtimeFences: [] } });
  expect(withEmpty).toBe(withoutField);
  expect(withoutField).toContain("fully static");
  expect(withoutField).not.toContain("unreached");
});

test("the unreached group follows the blockers and the reached deferrals", () => {
  const out = renderCoverage({
    ...base,
    stats: stats(3, 2),
    diagnostics: [fence("SC1040", "loose equality (== and !=) is not supported yet", 5)],
    runtimeFences: [fence("SC1090", "spread arguments are not supported yet", 6)],
    unreached: {
      stats: stats(1, 1),
      diagnostics: [],
      runtimeFences: [fence("SC2020", "'Object.setPrototypeOf' is part of the standard library types but has no scriptc lowering yet", 40)],
    },
  });
  const lines = out.split("\n");
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  expect(at("deferred to runtime")).toBeGreaterThan(-1);
  expect(at("blockers:")).toBeGreaterThan(at("deferred to runtime"));
  expect(at("deferred in unreached code")).toBeGreaterThan(at("blockers:"));
  expect(lines[lines.length - 1]).toContain("'Object.setPrototypeOf'");
});

test("fence sites split the reached deferrals by when they can throw", () => {
  const fences = [
    fence("SC1090", "extending computed expressions are not supported yet", 1),
    fence("SC1090", "spread arguments are not supported yet", 2),
    fence("SC2004", "uses of 'x' inherit the blocker on its declaration", 3),
    fence("SC2011", "values of type 'undefined' have no static representation but run in the embedded dynamic engine, which this build does not include", 4),
  ];
  const tagged = renderCoverage({ ...base, stats: stats(4, 4), runtimeFences: fences, runtimeFenceSites: ["module-init", "function", "function", "declaration"] });
  expect(tagged).toContain("deferred to runtime   4 sites (JS statements that throw their fence if executed — 1 in module initialisation, 2 in function bodies, 1 at declaration)");
  const untagged = renderCoverage({ ...base, stats: stats(4, 4), runtimeFences: fences });
  expect(untagged).toContain("deferred to runtime   4 sites (JS statements that throw their fence if executed)");
  // Only the non-zero sites print.
  const initOnly = renderCoverage({ ...base, stats: stats(1, 1), runtimeFences: [fences[0]!], runtimeFenceSites: ["module-init"] });
  expect(initOnly).toContain("(JS statements that throw their fence if executed — 1 in module initialisation)");
});
