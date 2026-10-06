/* The streaming reporter (scripts/gate-rust-reporter.mjs) and the digest the
 * gate builds from it, through real vitest runs over synthetic test files:
 * the failures that leave every test passed or skipped (a throwing
 * beforeAll or afterAll, a module-level hook) must reach the verdict. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { digestVitestResults, exitStatusProblems, moduleFindings, readJsonl } from "../../scripts/gate-rust-core.mjs";

const repoRoot = join(import.meta.dirname, "../..");

describe("the streaming reporter, through a real vitest run", () => {
  /** One vitest process over synthetic test files that fail in the ways the
   * gate must not read as green; the digest of what the reporter wrote is
   * what the gate's verdict is built from. */
  const reporter = join(repoRoot, "scripts/gate-rust-reporter.mjs");
  const vitest = join(repoRoot, "node_modules/vitest/vitest.mjs");
  /** The environment without the markers of the vitest worker running this file. */
  const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST")));
  function runSynthetic(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-gate-reporter-"));
    const results = join(dir, "results.jsonl");
    try {
      for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
      writeFileSync(join(dir, "vitest.config.mjs"), "export default { test: { globals: true, include: ['*.test.mjs'] } };\n");
      const run = spawnSync(process.execPath, [vitest, "run", "--root", dir, "--config", join(dir, "vitest.config.mjs"), "--maxWorkers=1", "--reporter", reporter], {
        cwd: dir, encoding: "utf8", env: { ...cleanEnv(), SCRIPTC_GATE_RESULTS: results, SCRIPTC_GATE_PARENT_PID: "" },
      });
      return { run, digest: digestVitestResults(readJsonl(readFileSync(results, "utf8"))) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a failing afterAll, a failing beforeAll, a module-level afterAll and a retry that passes are all visible", () => {
    const { run, digest } = runSynthetic({
      "after.test.mjs": "describe('S', () => { test('one', () => {}); test('two', () => {}); afterAll(() => { throw new Error('afterAll exploded'); }); });\n",
      "before.test.mjs": "describe('B', () => { beforeAll(() => { throw new Error('beforeAll exploded'); }); test('x', () => {}); test('y', () => {}); });\ndescribe('ok', () => { test('fine', () => {}); });\n",
      "module.test.mjs": "test('alone', () => {});\nafterAll(() => { throw new Error('module afterAll exploded'); });\n",
      "flaky.test.mjs": "let attempts = 0;\ntest('flaky', { retry: 1 }, () => { attempts += 1; if (attempts === 1) throw new Error('first attempt'); });\n",
    });
    expect(run.status).toBe(1);
    const entry = (file: string) => digest.files.find((candidate) => candidate.file === file)!;
    const outcomesOf = (file: string) => digest.outcomes.filter((outcome) => outcome.file === file);
    // Every test in after.test.mjs passed, yet the file failed: only the suite record shows why.
    expect(outcomesOf("after.test.mjs").map((outcome) => outcome.state)).toEqual(["passed", "passed"]);
    expect(moduleFindings(entry("after.test.mjs"), outcomesOf("after.test.mjs")).reds.map((red) => [red.id, red.firstLines])).toEqual([["after.test.mjs > S [suite hook failed]", "afterAll exploded"]]);
    // A throwing beforeAll skips its tests; the sibling describe's passing test must not hide it.
    expect(outcomesOf("before.test.mjs").filter((outcome) => outcome.state === "skipped" || outcome.state === "failed")).toHaveLength(2);
    expect(moduleFindings(entry("before.test.mjs"), outcomesOf("before.test.mjs")).reds.map((red) => red.id)).toEqual(["before.test.mjs > B [suite hook failed]"]);
    // A throwing module-level afterAll lands in the module's own errors.
    const moduleFound = moduleFindings(entry("module.test.mjs"), outcomesOf("module.test.mjs"));
    expect(moduleFound.reds.map((red) => [red.id, red.firstLines])).toEqual([["module.test.mjs", "module afterAll exploded"]]);
    // The retry that passes is flagged flaky.
    expect(outcomesOf("flaky.test.mjs")).toMatchObject([{ state: "passed", flaky: true, retryCount: 1 }]);
    // With the failures recorded, the exit status needs no further explanation.
    expect(exitStatusProblems({ exitCode: 1, signal: null, timedOut: false, spawnError: null, durationMs: 1 }, digest)).toEqual([]);
  }, 120_000);

  test("a green run records nothing for the exit-status rules to object to", () => {
    const { run, digest } = runSynthetic({ "green.test.mjs": "test('a', () => {});\ntest('b', () => {});\n" });
    expect(run.status).toBe(0);
    expect(digest.outcomes.map((outcome) => outcome.state)).toEqual(["passed", "passed"]);
    expect(digest.evidence).toEqual({ failedTests: 0, suiteErrors: 0, moduleErrors: 0, failedModules: 0, unhandled: 0 });
    expect(exitStatusProblems({ exitCode: 0, signal: null, timedOut: false, spawnError: null, durationMs: 1 }, digest)).toEqual([]);
  }, 120_000);
});
