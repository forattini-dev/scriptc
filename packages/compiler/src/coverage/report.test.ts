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
