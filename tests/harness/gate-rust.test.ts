/* The Rust gate's decision rules (scripts/gate-rust-core.mjs), pinned on
 * synthetic input: option defaults, the CI focus-list extraction, result
 * digestion, cargo log parsing and the baseline verdict. The plumbing that
 * spawns cargo and vitest is exercised only through --dry-run here; the
 * real runs are documented in tests/dogfood/rust-gate.md. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { shardOf } from "./shard.js";
import {
  QUICK_SAMPLE,
  QUICK_SHARDS,
  STEP_IDS,
  UsageError,
  corpusShardIndices,
  defaultJobs,
  digestVitestResults,
  evaluate,
  extractFocusLists,
  inScope,
  normalizeBaseline,
  parseArgs,
  parseCargoTestLog,
  parseClippyLog,
  readJsonl,
  renderSummary,
} from "../../scripts/gate-rust-core.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const host = { cpus: 12, memoryGb: 16 };

describe("options", () => {
  test("full mode runs every step over sixteen shards", () => {
    const options = parseArgs([], host);
    expect(options.mode).toBe("full");
    expect(options.selectedSteps).toEqual(STEP_IDS);
    expect(options.shards).toBe(16);
    expect(options.sample).toBeNull();
    expect(corpusShardIndices(options)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(options.jobs).toBe(4);
  });

  test("quick mode samples fixed shards and leaves the Node 24 lane out", () => {
    const options = parseArgs(["--quick"], host);
    expect(options.mode).toBe("quick");
    expect(options.selectedSteps).toEqual(["runtime-crate", "corpus", "focus-node26"]);
    expect(options.shards).toBe(QUICK_SHARDS);
    expect(options.sample).toEqual(QUICK_SAMPLE);
    expect(corpusShardIndices(options)).toEqual(QUICK_SAMPLE);
  });

  test("steps, skips, inline values and samples compose", () => {
    const options = parseArgs(["--steps", "corpus,focus-node24", "--skip=focus-node24", "--shards=40", "--sample", "3,1,3", "--jobs", "2"], host);
    expect(options.selectedSteps).toEqual(["corpus"]);
    expect(options.sample).toEqual([1, 3]);
    expect(options.jobs).toBe(2);
    expect(options.mode).toBe("custom");
  });

  test("a bare -- separator is ignored", () => {
    expect(parseArgs(["--", "--quick"], host).mode).toBe("quick");
  });

  test("usage errors name the offending argument", () => {
    expect(() => parseArgs(["--bogus"], host)).toThrow(UsageError);
    expect(() => parseArgs(["--steps", "corpus,nope"], host)).toThrow(/unknown step 'nope'/);
    expect(() => parseArgs(["--shards", "4", "--sample", "5"], host)).toThrow(/exceeds --shards/);
    expect(() => parseArgs(["--jobs", "0"], host)).toThrow(/--jobs expects/);
    expect(() => parseArgs(["--out"], host)).toThrow(/expects a value/);
  });

  test("default jobs follow cores and memory, never below one", () => {
    expect(defaultJobs({ cpus: 12, memoryGb: 16 })).toBe(4);
    expect(defaultJobs({ cpus: 4, memoryGb: 16 })).toBe(1);
    expect(defaultJobs({ cpus: 64, memoryGb: 8 })).toBe(2);
    expect(defaultJobs({ cpus: 1, memoryGb: 1 })).toBe(1);
  });
});

describe("CI focus list", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  test("node_26_host names one list for both targets and every file exists", () => {
    const lanes = extractFocusLists(workflow);
    expect(lanes.node26.files.length).toBeGreaterThan(0);
    expect(lanes.node24.files).toEqual(lanes.node26.files);
    for (const file of lanes.node26.files) expect(existsSync(join(repoRoot, file)), file).toBe(true);
    expect(new Set(lanes.node26.files).size).toBe(lanes.node26.files.length);
  });

  test("a divergent pair of lists is refused", () => {
    const yaml = `jobs:\n  node_26_host:\n    steps:\n      - name: a\n        env: { SCRIPTC_RUNTIME_TARGET: node26 }\n        run: >-\n          pnpm exec vitest run\n          tests/harness/a.test.ts\n          --maxWorkers=1\n      - name: b\n        env: { SCRIPTC_RUNTIME_TARGET: node24 }\n        run: pnpm exec vitest run tests/harness/b.test.ts --maxWorkers=1\n`;
    expect(() => extractFocusLists(yaml)).toThrow(/differ/);
    expect(() => extractFocusLists("jobs: {}")).toThrow(/node_26_host/);
  });
});

describe("vitest result stream", () => {
  const stream = [
    { type: "run-start", modules: ["tests/harness/rust-differential.test.ts"] },
    { type: "module-collected", file: "tests/harness/rust-differential.test.ts", tests: ["001-hello.ts", "002-fails.ts", "003-lost.ts", "004-flaky.ts", "005-skip.ts"] },
    { type: "test", file: "tests/harness/rust-differential.test.ts", name: "001-hello.ts", fullName: "corpus > 001-hello.ts", state: "passed", durationMs: 1200, retryCount: 0, flaky: false, note: null, errors: [] },
    { type: "test", file: "tests/harness/rust-differential.test.ts", name: "002-fails.ts", fullName: "corpus > 002-fails.ts", state: "failed", durationMs: 2400, retryCount: 1, flaky: false, note: null, errors: ["expected 'a' to be 'b'", "expected 'a' to be 'b'"] },
    { type: "test", file: "tests/harness/rust-differential.test.ts", name: "004-flaky.ts", fullName: "corpus > 004-flaky.ts", state: "passed", durationMs: 900, retryCount: 1, flaky: true, note: null, errors: ["ETXTBSY"] },
    { type: "test", file: "tests/harness/rust-differential.test.ts", name: "005-skip.ts", fullName: "corpus > 005-skip.ts", state: "skipped", durationMs: 0, retryCount: 0, flaky: false, note: "no oracle for // @target bun", errors: [] },
    { type: "console", stream: "stdout", content: "rust parity: 2/5 corpus programs claimed; REGRESSED kinds: x×1" },
    { type: "module-end", file: "tests/harness/rust-differential.test.ts", state: "failed", durationMs: 4500, errors: [] },
    { type: "run-end", reason: "failed", unhandledErrors: [] },
  ];

  test("digests outcomes, flags the program that never ran, and keeps the parity line", () => {
    const text = `${stream.map((record) => JSON.stringify(record)).join("\n")}\n{"type":"test","file":"x","na`;
    const digest = digestVitestResults(readJsonl(text));
    const byName = Object.fromEntries(digest.outcomes.map((outcome) => [outcome.name, outcome]));
    expect(byName["001-hello.ts"].state).toBe("passed");
    expect(byName["002-fails.ts"]).toMatchObject({ state: "failed", retryCount: 1, errors: ["expected 'a' to be 'b'", "expected 'a' to be 'b'"] });
    expect(byName["003-lost.ts"].state).toBe("missing");
    expect(byName["004-flaky.ts"]).toMatchObject({ state: "passed", flaky: true });
    expect(byName["005-skip.ts"]).toMatchObject({ state: "skipped", note: "no oracle for // @target bun" });
    expect(digest.parity).toEqual({ claimed: 2, total: 5, line: "rust parity: 2/5 corpus programs claimed; REGRESSED kinds: x×1" });
    expect(digest.runEnd?.reason).toBe("failed");
    expect(digest.files[0]).toMatchObject({ ended: true, state: "failed", durationMs: 4500 });
  });

  test("repeated test titles are counted as a multiset, not collapsed", () => {
    const records = [
      { type: "module-collected", file: "f.test.ts", tests: ["same", "same", "same"] },
      { type: "test", file: "f.test.ts", name: "same", fullName: "same", state: "passed", durationMs: 1, retryCount: 0, flaky: false, note: null, errors: [] },
      { type: "test", file: "f.test.ts", name: "same", fullName: "same", state: "failed", durationMs: 1, retryCount: 0, flaky: false, note: null, errors: ["boom"] },
      { type: "module-end", file: "f.test.ts", state: "failed", durationMs: 2, errors: [] },
    ];
    const digest = digestVitestResults(records);
    expect(digest.outcomes.map((outcome) => outcome.state)).toEqual(["passed", "failed", "missing"]);
  });

  test("a stream cut off by a crash still yields what finished", () => {
    const text = stream.slice(0, 4).map((record) => JSON.stringify(record)).join("\n");
    const digest = digestVitestResults(readJsonl(text));
    expect(digest.runEnd).toBeNull();
    expect(digest.files[0].ended).toBe(false);
    expect(digest.outcomes.filter((outcome) => outcome.state === "missing").map((outcome) => outcome.name)).toEqual(["003-lost.ts", "004-flaky.ts", "005-skip.ts"]);
  });
});

describe("cargo logs", () => {
  test("cargo test: per-binary outcomes, should-panic names, failure detail and summaries", () => {
    const log = [
      "   Compiling scriptc-runtime v0.0.35",
      "     Running unittests src/lib.rs (target/debug/deps/scriptc_runtime-0123)",
      "running 4 tests",
      "test a::one ... ok",
      "test a::two - should panic ... ok",
      "test a::three ... FAILED",
      "test a::four ... ignored",
      "",
      "failures:",
      "",
      "---- a::three stdout ----",
      "thread 'a::three' panicked at src/a.rs:9:5:",
      "assertion `left == right` failed",
      "",
      "failures:",
      "    a::three",
      "",
      "test result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s",
      "   Doc-tests scriptc_runtime",
      "running 1 test",
      "test src/lib.rs - docs (line 3) ... ok",
      "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s",
    ].join("\n");
    const parsed = parseCargoTestLog(log);
    expect(parsed.counts).toEqual({ passed: 3, failed: 1, ignored: 1 });
    expect(parsed.summaries).toBe(2);
    expect(parsed.binaries).toEqual(["src/lib.rs", "doc:scriptc_runtime"]);
    expect(parsed.passed.map((test) => test.id)).toEqual(["cargo-test::src/lib.rs::a::one", "cargo-test::src/lib.rs::a::two", "cargo-test::doc:scriptc_runtime::src/lib.rs"]);
    expect(parsed.failures).toEqual([
      { id: "cargo-test::src/lib.rs::a::three", name: "a::three", binary: "src/lib.rs", firstLines: "thread 'a::three' panicked at src/a.rs:9:5:\nassertion `left == right` failed" },
    ]);
  });

  test("a build failure surfaces its error lines", () => {
    const parsed = parseCargoTestLog("   Compiling x\nerror[E0425]: cannot find value `y`\n --> src/lib.rs:1:1\nerror: could not compile `x`\n");
    expect(parsed.summaries).toBe(0);
    expect(parsed.errorLines).toEqual(["error[E0425]: cannot find value `y`", "error: could not compile `x`"]);
  });

  test("clippy under -D warnings counts lints, not the trailing compile error", () => {
    const parsed = parseClippyLog("error: using `chunks_exact` with a constant chunk size\n  --> src/zlib.test.rs:30:14\n   |\nerror: could not compile `scriptc-runtime` (lib test) due to 1 previous error\n");
    expect(parsed.errorCount).toBe(1);
    expect(parsed.firstLines).toBe("error: using `chunks_exact` with a constant chunk size (--> src/zlib.test.rs:30:14)");
    expect(parseClippyLog("    Finished `dev` profile\n")).toEqual({ errorCount: 0, firstLines: "" });
  });
});

describe("baseline verdict", () => {
  const corpusScope = (shardCount: number, completed: number[], ran = completed) => ({ kind: "corpus", shardCount, ranShards: ran, completedShards: completed });
  const idle = (id: string) => ({ id, ran: false, reds: [], passed: [], skipped: [], problems: [], scope: { kind: "none" } });
  const programInShard = (shardCount: number, shard: number, prefix: string) => {
    for (let i = 0; i < 100_000; i += 1) {
      const id = `${prefix}-${i}.ts`;
      if (shardOf(id, shardCount) === shard) return id;
    }
    throw new Error("unreachable");
  };
  const knownRed = programInShard(4, 1, "known");
  const fixedRed = programInShard(4, 1, "fixed");
  const elsewhere = programInShard(4, 3, "elsewhere");
  const gone = programInShard(4, 1, "gone");
  const fresh = programInShard(4, 1, "fresh");
  const baseline = normalizeBaseline({
    schema: 1,
    reds: { corpus: { [knownRed]: "old reason", [fixedRed]: "was red", [elsewhere]: "other shard", [gone]: "deleted since" }, "runtime-crate": { "cargo-clippy": "lint" } },
    calibration: {},
  });
  const corpusStep = (reds: string[], passed: string[], problems: { id: string; message: string }[] = [], scope = corpusScope(4, [1])) => ({
    id: "corpus", ran: true, scope, problems, skipped: [],
    reds: reds.map((id) => ({ id, firstLines: `expected 'a' to be 'b' in ${id}` })),
    passed,
  });

  test("a red the baseline does not know fails; known reds pass; fixed and stale are listed; other shards are not checked", () => {
    const steps = [idle("runtime-crate"), corpusStep([knownRed, fresh], [fixedRed]), idle("focus-node26"), idle("focus-node24")];
    const verdict = evaluate(steps, baseline, { repoRoot: "/repo", commit: "abc", date: "2026-10-05" });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.exitCode).toBe(1);
    expect(verdict.newReds.map((red) => red.id)).toEqual([fresh]);
    expect(verdict.stillRed.map((red) => red.id)).toEqual([knownRed]);
    expect(verdict.reasonChanged.map((red) => red.id)).toEqual([knownRed]);
    expect(verdict.fixed).toEqual([{ step: "corpus", id: fixedRed }]);
    expect(verdict.stale).toEqual([{ step: "corpus", id: gone }]);
    expect(verdict.notChecked).toEqual([{ step: "runtime-crate", id: "cargo-clippy" }, { step: "corpus", id: elsewhere }]);
    // The rewritten baseline: current reds in scope, untouched entries out of scope, fixed and stale dropped.
    expect(verdict.nextBaseline.reds).toEqual({
      corpus: { [elsewhere]: "other shard", [fresh]: `expected 'a' to be 'b' in ${fresh}`, [knownRed]: `expected 'a' to be 'b' in ${knownRed}` },
      "runtime-crate": { "cargo-clippy": "lint" },
    });
    expect(verdict.nextBaseline.calibration.corpus).toEqual({ commit: "abc", date: "2026-10-05", scope: "shards 1 of 4", complete: false });
    expect(verdict.nextBaseline.calibration["runtime-crate"]).toBeUndefined();
  });

  test("only known reds and no problems pass", () => {
    const verdict = evaluate([idle("runtime-crate"), corpusStep([knownRed], [fixedRed, gone]), idle("focus-node26"), idle("focus-node24")], baseline);
    expect(verdict.verdict).toBe("pass");
    expect(verdict.exitCode).toBe(0);
    expect(verdict.stale).toEqual([]);
  });

  test("a crashed shard fails the gate and keeps its baseline entries", () => {
    const step = corpusStep([], [], [{ id: "shard-1", message: "shard 1/4: crashed (signal SIGKILL)" }], corpusScope(4, [], [1]));
    const verdict = evaluate([idle("runtime-crate"), step, idle("focus-node26"), idle("focus-node24")], baseline);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.newReds).toEqual([]);
    expect(verdict.problems).toEqual([{ step: "corpus", id: "shard-1", message: "shard 1/4: crashed (signal SIGKILL)" }]);
    expect(verdict.stale).toEqual([]);
    expect(Object.keys(verdict.nextBaseline.reds.corpus).sort()).toEqual([knownRed, fixedRed, elsewhere, gone].sort());
  });

  test("file and cargo scopes", () => {
    const files = { kind: "files", files: ["a.test.ts", "b.test.ts"], completedFiles: ["a.test.ts"] };
    expect(inScope(files, "a.test.ts > suite > case")).toBe(true);
    expect(inScope(files, "a.test.ts")).toBe(true);
    expect(inScope(files, "b.test.ts > case")).toBe(false);
    expect(inScope(files, "a.test.tsx > case")).toBe(false);
    const cargo = { kind: "cargo", testRan: true, clippyRan: false, testResultsParsed: false };
    expect(inScope(cargo, "cargo-test")).toBe(true);
    expect(inScope(cargo, "cargo-test::src/lib.rs::a")).toBe(false);
    expect(inScope(cargo, "cargo-clippy")).toBe(false);
    expect(inScope({ kind: "none" }, "anything")).toBe(false);
  });

  test("malformed baselines are refused rather than read as empty", () => {
    expect(() => normalizeBaseline({ schema: 2, reds: {} })).toThrow(/schema/);
    expect(() => normalizeBaseline({ schema: 1, reds: { nope: {} } })).toThrow(/unknown step/);
    expect(() => normalizeBaseline({ schema: 1, reds: { corpus: ["x"] } })).toThrow(/object of id/);
    expect(normalizeBaseline({ schema: 1 })).toEqual({ schema: 1, reds: {}, calibration: {} });
  });

  test("the summary names the verdict, the new reds and the fixed entries", () => {
    const steps = [idle("runtime-crate"), { ...corpusStep([fresh], [fixedRed]), durationMs: 65_000, headline: "shards 1 of 4" }, idle("focus-node26"), idle("focus-node24")];
    const verdict = evaluate(steps, baseline, { repoRoot: "/repo" });
    const summary = renderSummary({
      mode: "custom", durationMs: 70_000, finishedAt: "2026-10-05T00:00:00Z",
      repo: { root: "/repo", commit: "0123456789", dirty: false },
      steps, baseline: { path: "tests/dogfood/rust-gate-baseline.json", updated: false }, verdict, paths: { report: "/out/report.json" },
    });
    expect(summary).toContain("gate:rust FAIL (1 new red, 0 problems)");
    expect(summary).toContain(`corpus::${fresh}`);
    expect(summary).toContain(`fixed (remove from the baseline):\n  corpus::${fixedRed}`);
    expect(summary).toContain("corpus         FAIL    1m05s  shards 1 of 4");
    expect(summary).toContain("focus-node24   skip      n/a  not selected");
  });
});

describe("command line", () => {
  const tsx = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
  const script = join(repoRoot, "scripts/gate-rust.mjs");

  test("--dry-run prints the plan: one shard process per sample index, each with its own TMPDIR", () => {
    const output = execFileSync(process.execPath, [tsx, script, "--quick", "--dry-run"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, SCRIPTC_NATIVE_HOST_WORKERS: undefined } });
    const plan = JSON.parse(output);
    expect(plan.mode).toBe("quick");
    expect(plan.steps.map((step: { id: string }) => step.id)).toEqual(["runtime-crate", "corpus", "focus-node26"]);
    const corpus = plan.steps[1];
    expect(corpus.shards.map((shard: { index: number }) => shard.index)).toEqual(QUICK_SAMPLE);
    const tmpDirs = corpus.shards.map((shard: { env: Record<string, string> }) => shard.env.TMPDIR);
    expect(new Set(tmpDirs).size).toBe(tmpDirs.length);
    expect(corpus.shards[0].env.SCRIPTC_TEST_SHARD).toBe(`1/${QUICK_SHARDS}`);
    expect(corpus.shards[0].env.SCRIPTC_REQUIRE_TARGETS).toBe("1");
    expect(corpus.shards[0].env.SCRIPTC_NATIVE_HOST_WORKERS).toBe(String(Math.max(2, plan.jobs)));
    expect(corpus.shards[0].args).toContain("tests/harness/rust-differential.test.ts");
    const focus = plan.steps[2];
    expect(focus.env.SCRIPTC_RUNTIME_TARGET).toBe("node26");
    expect(focus.files.length).toBeGreaterThan(0);
    expect(plan.steps[0].commands.map((command: { command: string; args: string[] }) => [command.command, ...command.args].join(" "))).toEqual([
      "cargo test --locked --no-fail-fast",
      "cargo clippy --all-targets --locked -- -D warnings",
    ]);
  });

  test("--focus-file replaces the CI list and --steps narrows the plan", () => {
    const output = execFileSync(process.execPath, [tsx, script, "--dry-run", "--steps", "focus-node24", "--focus-file", "tests/harness/gate-rust.test.ts", "--focus-workers", "1"], { cwd: repoRoot, encoding: "utf8" });
    const plan = JSON.parse(output);
    expect(plan.steps.map((step: { id: string }) => step.id)).toEqual(["focus-node24"]);
    const focus = plan.steps[0];
    expect(focus.files).toEqual(["tests/harness/gate-rust.test.ts"]);
    expect(focus.source).toBe("--focus-file");
    expect(focus.vitestFlags[0]).toBe("--maxWorkers=1");
    expect(focus.env.SCRIPTC_RUNTIME_TARGET).toBe("node24");
    expect(focus.env.SCRIPTC_NODE_ORACLE).toBe(focus.node.executable);
  });

  test("an unknown flag is a usage error with exit code 2", () => {
    const result = spawnSync(process.execPath, [tsx, script, "--bogus"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument '--bogus'");
  });

  test("--rejudge: a red fails the exit code until --update-baseline records it", () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-gate-rust-"));
    try {
      const report = join(dir, "report.json");
      const baseline = join(dir, "baseline.json");
      writeFileSync(report, JSON.stringify({
        tool: "gate-rust", mode: "custom", startedAt: "2026-10-05T00:00:00.000Z", durationMs: 1000, repo: { root: repoRoot, commit: "abc123", dirty: false },
        steps: [
          { id: "runtime-crate", ran: true, durationMs: 10, headline: "cargo test: 1 passed", reds: [], passed: ["cargo-test", "cargo-clippy"], skipped: [], problems: [], scope: { kind: "cargo", testRan: true, clippyRan: true, testResultsParsed: true } },
          { id: "corpus", ran: true, durationMs: 20, headline: "shards 1 of 2", reds: [{ id: "999-synthetic.ts", firstLines: "expected 'x' to be 'y'" }], passed: [], skipped: [], problems: [], scope: { kind: "corpus", shardCount: 2, ranShards: [1], completedShards: [1] } },
          { id: "focus-node26", ran: false, reds: [], passed: [], skipped: [], problems: [], scope: { kind: "none" } },
          { id: "focus-node24", ran: false, reds: [], passed: [], skipped: [], problems: [], scope: { kind: "none" } },
        ],
      }));
      const run = (...args: string[]) => spawnSync(process.execPath, [tsx, script, "--rejudge", report, "--baseline", baseline, "--out", join(dir, "out"), ...args], { cwd: repoRoot, encoding: "utf8" });
      const red = run();
      expect(red.status, red.stderr).toBe(1);
      expect(red.stdout).toContain("gate:rust FAIL (1 new red, 0 problems)");
      expect(red.stdout).toContain("corpus::999-synthetic.ts");
      const update = run("--update-baseline");
      expect(update.status, update.stderr).toBe(0);
      const written = JSON.parse(readFileSync(baseline, "utf8"));
      expect(written.reds).toEqual({ corpus: { "999-synthetic.ts": "expected 'x' to be 'y'" } });
      expect(written.calibration.corpus).toMatchObject({ commit: "abc123", scope: "shards 1 of 2", complete: false });
      const known = run();
      expect(known.status, known.stderr).toBe(0);
      expect(known.stdout).toContain("gate:rust PASS (0 new reds, 0 problems)");
      expect(known.stdout).toContain("corpus         known");
      const summary = readFileSync(join(dir, "out/summary.txt"), "utf8");
      expect(summary).toContain("1 known red still red");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
