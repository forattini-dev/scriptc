import { describe, expect, test } from "vitest";
import { renderCoverage, type CoverageInput } from "./report.js";

const STATIC_PROGRAM: CoverageInput = {
  file: "src/main.ts",
  stats: { statementsTotal: 4, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0 },
  diagnostics: [],
  preflightFailed: false,
  npmStatic: [
    { package: "pure-barrel", status: "static", prunedModules: ["chain/spare.js", "fenced.js"] },
    { package: "single", status: "static" },
    { package: "stateful", status: "fallback", detail: "SC1013: something" },
  ],
};

describe("the --npm-static section of the coverage report", () => {
  test("a static package's row counts the modules the program never evaluates", () => {
    const out = renderCoverage(STATIC_PROGRAM);
    expect(out).toContain("pure-barrel  static (2 modules not evaluated: unused re-exports of a sideEffects-free package)");
    expect(out).toContain("single       static\n");
    expect(out).toContain("stateful     island fallback (SC1013: something)");
    expect(out).not.toContain("- chain/spare.js");
  });

  test("the verbose render lists every pruned module under its package", () => {
    const out = renderCoverage(STATIC_PROGRAM, { listPrunedModules: true });
    expect(out).toContain("pure-barrel  static (2 modules not evaluated: unused re-exports of a sideEffects-free package)\n      - chain/spare.js\n      - fenced.js\n");
  });

  test("one pruned module reads in the singular", () => {
    const out = renderCoverage({ ...STATIC_PROGRAM, npmStatic: [{ package: "pure-barrel", status: "static", prunedModules: ["fenced.js"] }] });
    expect(out).toContain("(1 module not evaluated:");
  });
});
