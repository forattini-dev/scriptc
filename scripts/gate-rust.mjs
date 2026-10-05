#!/usr/bin/env tsx
/* The Rust-scoped validation gate: `pnpm gate:rust`.
 *
 * Four steps, every one of them run and reported even when an earlier one
 * fails, so a run yields a failure inventory rather than the first red:
 *
 *   runtime-crate  cargo test + cargo clippy -D warnings in packages/runtime-rust
 *                  on the toolchain its rust-toolchain.toml pins
 *   corpus         tests/harness/rust-differential.test.ts, split with
 *                  SCRIPTC_TEST_SHARD into shard processes that run a few
 *                  at a time, each with its own TMPDIR, streaming results
 *                  through scripts/gate-rust-reporter.mjs
 *   focus-node26   CI's focused Rust regression list (read from
 *                  .github/workflows/ci.yml, job node_26_host) on Node 26
 *                  with target node26
 *   focus-node24   the same list on Node 24 with target node24
 *
 * The verdict compares the reds against tests/dogfood/rust-gate-baseline.json:
 * a red the baseline does not know fails the gate, a known red passes, a
 * baseline entry that now passes is reported for removal, and a shard that
 * crashed, a file that did not run, or a child whose exit status the
 * recorded results do not explain always fails. See
 * tests/dogfood/rust-gate.md. The decision logic lives in
 * scripts/gate-rust-core.mjs; this file is the plumbing. */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, globSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, homedir, loadavg, platform, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE24_VERSION, NODE26_VERSION } from "../packages/compiler/src/compat/node-matrix.js";
import { DRIVER_FIXTURES } from "../tests/harness/driver-fixtures.js";
import {
  CORPUS_TEST_FILE, REPORT_SCHEMA, USAGE, UsageError,
  baselineReason, corpusShardIndices, describeCrash, digestVitestResults, emptyBaseline, evaluate, exitStatusProblems, extractFocusLists,
  formatDuration, moduleFindings, normalizeBaseline, parseArgs, parseCargoTestLog, parseClippyLog, readJsonl, renderSummary,
} from "./gate-rust-core.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reporterPath = join(repoRoot, "scripts/gate-rust-reporter.mjs");
const vitestPath = join(repoRoot, "node_modules/vitest/vitest.mjs");
const runtimeCrateDir = join(repoRoot, "packages/runtime-rust");

const log = (message) => process.stderr.write(`[gate-rust] ${message}\n`);

// ---- host, repo, interpreters, toolchain -------------------------------------

function hostInfo() {
  return { platform: platform(), cpus: cpus().length, memoryGb: totalmem() / (1024 ** 3), loadavgStart: loadavg().map((v) => Number(v.toFixed(2))), node: process.version };
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function repoInfo() {
  return {
    root: repoRoot,
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "",
  };
}

function interpreterVersion(executable) {
  try {
    return execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^v/, "");
  } catch {
    return null;
  }
}

/** Same search order as tests/harness/node-matrix.ts, with the same
 * refusal of a candidate whose --version disagrees with the pin. */
function resolveNode(label, version, explicit, env) {
  const variable = `SCRIPTC_NODE_${label.toUpperCase()}`;
  const miseData = env["MISE_DATA_DIR"] ?? join(homedir(), ".local/share/mise");
  let miseWhich = null;
  try {
    miseWhich = execFileSync("mise", ["which", `node@${version}`], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    miseWhich = null;
  }
  const candidates = [explicit, env[variable], process.execPath, join(miseData, "installs/node", version, "bin/node"), miseWhich]
    .filter((candidate) => typeof candidate === "string" && candidate !== "");
  const rejected = [];
  for (const candidate of candidates) {
    if (candidate !== process.execPath && !existsSync(candidate)) continue;
    const found = interpreterVersion(candidate);
    if (found === version) return { executable: candidate, version: found };
    if (candidate === explicit || candidate === env[variable]) {
      return { executable: null, version: null, error: `${candidate} reports Node ${found ?? "nothing"}; the ${label} lane needs Node ${version}` };
    }
    if (found !== null) rejected.push(`${candidate} (Node ${found})`);
  }
  return { executable: null, version: null, error: `no Node ${version} interpreter found for ${label} (install it with 'mise install node@${version}' or point ${variable} at one${rejected.length ? `; rejected ${rejected.join(", ")}` : ""})` };
}

function pinnedToolchain() {
  const text = readFileSync(join(runtimeCrateDir, "rust-toolchain.toml"), "utf8");
  const match = /^\s*channel\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) throw new Error("packages/runtime-rust/rust-toolchain.toml has no channel pin");
  return match[1];
}

function toolVersion(command, args, env) {
  try {
    return execFileSync(command, args, { encoding: "utf8", env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0];
  } catch (error) {
    return `unavailable: ${String(error?.stderr ?? error?.message ?? error).trim().split("\n")[0]}`;
  }
}

// ---- process runner -----------------------------------------------------------

/** Peak resident memory per process group, sampled with one `ps` for all
 * live children; null wherever ps is unavailable. */
class MemoryMeter {
  constructor() {
    this.groups = new Map();
    this.timer = null;
  }
  watch(pgid) {
    this.groups.set(pgid, { peakBytes: 0 });
    if (this.timer === null) {
      this.timer = setInterval(() => this.sample(), 5000);
      this.timer.unref();
    }
    return this.groups.get(pgid);
  }
  unwatch(pgid) {
    this.groups.delete(pgid);
    if (this.groups.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  sample() {
    if (process.platform === "win32") return;
    let output;
    try {
      output = execFileSync("ps", ["-eo", "pgid=,rss="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return;
    }
    const totals = new Map();
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pgid = Number(match[1]);
      totals.set(pgid, (totals.get(pgid) ?? 0) + Number(match[2]) * 1024);
    }
    for (const [pgid, record] of this.groups) {
      record.peakBytes = Math.max(record.peakBytes, totals.get(pgid) ?? 0);
    }
  }
}

const meter = new MemoryMeter();
const liveChildren = new Set();
let interrupted = false;

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Run one child in its own process group with both streams appended to
 * `logPath`, a wall-clock cap, and a memory meter. Never throws on a
 * failing child: the caller reads exitCode/signal/timedOut. */
function runChild({ command, args, cwd, env, logPath, timeoutMs, label }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  writeFileSync(fd, `$ ${[command, ...args].join(" ")}\n(cwd ${cwd})\n\n`);
  const started = Date.now();
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", fd, fd], detached: process.platform !== "win32" });
    } catch (error) {
      closeSync(fd);
      resolveRun({ exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started, spawnError: error.message, peakBytes: null });
      return;
    }
    liveChildren.add(child);
    const memory = meter.watch(child.pid);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`${label}: exceeded ${formatDuration(timeoutMs)}, terminating`);
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 15_000).unref();
    }, timeoutMs);
    const finish = (exitCode, signal, spawnError) => {
      clearTimeout(timer);
      meter.sample();
      meter.unwatch(child.pid);
      liveChildren.delete(child);
      closeSync(fd);
      resolveRun({ exitCode, signal, timedOut, durationMs: Date.now() - started, spawnError: spawnError ?? null, peakBytes: memory.peakBytes || null });
    };
    child.on("error", (error) => finish(null, null, error.message));
    child.on("exit", (code, signal) => finish(code, signal, null));
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    log(`${signal}: stopping ${liveChildren.size} child process group(s)`);
    for (const child of liveChildren) killGroup(child, "SIGTERM");
    setTimeout(() => { for (const child of liveChildren) killGroup(child, "SIGKILL"); }, 10_000).unref();
  });
}

// ---- steps ----------------------------------------------------------------------

function childEnv(base, overrides, unset = []) {
  const env = { ...base };
  for (const name of unset) delete env[name];
  Object.assign(env, overrides);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  return env;
}

/** The plan is data first so --dry-run can print it and the test can pin
 * it; `execute` is the only side effect. */
function planRuntimeCrate(context) {
  const env = childEnv(process.env, { RUSTUP_TOOLCHAIN: context.toolchain });
  const common = { cwd: runtimeCrateDir, env, timeoutMs: context.options.timeoutMin * 60_000 };
  return {
    id: "runtime-crate",
    commands: [
      { id: "cargo-test", command: "cargo", args: ["test", "--locked", "--no-fail-fast"], logPath: join(context.outDir, "runtime-crate/cargo-test.log"), ...common },
      { id: "cargo-clippy", command: "cargo", args: ["clippy", "--all-targets", "--locked", "--", "-D", "warnings"], logPath: join(context.outDir, "runtime-crate/cargo-clippy.log"), ...common },
    ],
  };
}

async function runRuntimeCrate(context, plan) {
  const started = Date.now();
  const step = { id: "runtime-crate", ran: true, reds: [], passed: [], skipped: [], problems: [], checks: [], scope: { kind: "cargo", testRan: false, clippyRan: false, testResultsParsed: false } };
  step.toolchain = {
    pin: context.toolchain,
    rustc: toolVersion("rustc", ["--version"], plan.commands[0].env),
    cargo: toolVersion("cargo", ["--version"], plan.commands[0].env),
  };
  if (step.toolchain.rustc.startsWith("unavailable")) {
    step.problems.push({ id: "toolchain", message: `rustc on toolchain ${context.toolchain} is ${step.toolchain.rustc}` });
  }
  for (const command of plan.commands) {
    log(`runtime-crate: ${command.id}`);
    const run = await runChild({ ...command, label: `runtime-crate ${command.id}` });
    const text = readFileSync(command.logPath, "utf8");
    const check = { id: command.id, command: [command.command, ...command.args].join(" "), exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut, durationMs: run.durationMs, peakBytes: run.peakBytes, log: command.logPath };
    if (run.spawnError !== null || run.timedOut || run.signal !== null) {
      step.problems.push({ id: command.id, message: `${command.id} did not complete (${run.spawnError ?? (run.timedOut ? "timed out" : `signal ${run.signal}`)})` });
    } else if (command.id === "cargo-test") {
      const parsed = parseCargoTestLog(text);
      step.scope.testRan = true;
      step.scope.testResultsParsed = parsed.summaries > 0;
      check.counts = parsed.counts;
      check.binaries = parsed.binaries;
      check.failures = parsed.failures;
      for (const failure of parsed.failures) step.reds.push({ id: failure.id, firstLines: failure.firstLines });
      // A test binary that never printed its result summary crashed (abort, SIGSEGV, kill):
      // its tests are not in any FAILED line, so it is reported on its own.
      for (const name of parsed.crashedBinaries) {
        step.reds.push({ id: `cargo-test::${name}`, firstLines: `test binary ${name} printed no result summary (it crashed or was killed)` });
      }
      check.crashedBinaries = parsed.crashedBinaries;
      // A nonzero exit that the per-test lines and crashed binaries do not account for
      // (a build failure, or more failed targets than failed tests explain) is a red of its own.
      const explainedTargets = new Set([...parsed.failures.map((failure) => failure.binary), ...parsed.crashedBinaries]);
      if (run.exitCode !== 0 && (explainedTargets.size === 0 || parsed.failedTargetLines > explainedTargets.size)) {
        step.reds.push({ id: "cargo-test", firstLines: parsed.errorLines.join("\n") || `cargo test exited ${run.exitCode} with ${parsed.failedTargetLines} failed target(s) but ${explainedTargets.size} explained by a failed test or a crashed binary` });
      }
      if (run.exitCode === 0 && parsed.summaries === 0) step.problems.push({ id: "cargo-test", message: "cargo test exited 0 but printed no test result summary" });
      if (run.exitCode === 0) step.passed.push("cargo-test");
      for (const test of parsed.passed) step.passed.push(test.id);
    } else {
      const parsed = parseClippyLog(text);
      step.scope.clippyRan = true;
      check.errorCount = parsed.errorCount;
      if (run.exitCode === 0) step.passed.push("cargo-clippy");
      else step.reds.push({ id: "cargo-clippy", firstLines: parsed.firstLines || `cargo clippy exited ${run.exitCode}` });
    }
    step.checks.push(check);
  }
  step.durationMs = Date.now() - started;
  const test = step.checks.find((c) => c.id === "cargo-test");
  const clippy = step.checks.find((c) => c.id === "cargo-clippy");
  step.headline = `${test?.counts ? `cargo test: ${test.counts.passed} passed, ${test.counts.failed} failed (${formatDuration(test.durationMs)})` : "cargo test: no result"} · ${clippy ? `cargo clippy: ${clippy.exitCode === 0 ? "clean" : `${clippy.errorCount} error${clippy.errorCount === 1 ? "" : "s"}`} (${formatDuration(clippy.durationMs)})` : "cargo clippy: no result"} · rustc ${step.toolchain.rustc.replace(/^rustc /, "")}`;
  return step;
}

function vitestEnv(context, lane, extra) {
  return childEnv(process.env, {
    RUSTUP_TOOLCHAIN: context.toolchain,
    SCRIPTC_NODE_NODE24: context.node24.executable ?? undefined,
    SCRIPTC_NODE_NODE26: context.node26.executable ?? undefined,
    SCRIPTC_GATE_RESULTS: lane.resultsPath,
    TMPDIR: lane.tmpDir,
    SCRIPTC_TEST_DISCARD_PASSED_BINARIES: context.options.keepBinaries ? undefined : "1",
    ...extra,
  }, ["SCRIPTC_SAN", "SCRIPTC_RUST_SAN", "SCRIPTC_TEST_SHARD", "SCRIPTC_NODE_ORACLE", "SCRIPTC_RUNTIME_TARGET"]);
}

function planCorpus(context) {
  const { options } = context;
  const indices = corpusShardIndices(options);
  const hostSeats = process.env["SCRIPTC_NATIVE_HOST_WORKERS"] ?? String(Math.max(2, options.jobs));
  const shards = indices.map((index) => {
    const dir = join(context.outDir, "corpus", `shard-${String(index).padStart(2, "0")}`);
    const lane = { resultsPath: join(dir, "results.jsonl"), tmpDir: join(context.tmpBase, `s${index}`) };
    return {
      index,
      count: options.shards,
      dir,
      logPath: join(dir, "vitest.log"),
      resultsPath: lane.resultsPath,
      tmpDir: lane.tmpDir,
      command: context.node26.executable,
      args: [vitestPath, "run", CORPUS_TEST_FILE, "--maxWorkers=1", "--reporter=default", `--reporter=${reporterPath}`],
      cwd: repoRoot,
      timeoutMs: options.timeoutMin * 60_000,
      env: vitestEnv(context, lane, {
        SCRIPTC_TEST_SHARD: `${index}/${options.shards}`,
        SCRIPTC_TEST_WORKERS: "1",
        SCRIPTC_NATIVE_HOST_WORKERS: hostSeats,
        SCRIPTC_REQUIRE_TARGETS: "1",
        SCRIPTC_RUST_REFUSALS: "1",
        ...(options.isolateCache ? { SCRIPTC_CACHE_DIR: join(dir, "cache") } : {}),
      }),
    };
  });
  return { id: "corpus", jobs: options.jobs, shards };
}

function corpusProgramCount() {
  const corpusDir = join(repoRoot, "tests/corpus");
  const names = new Set();
  for (const ext of ["ts", "js", "mjs", "cjs"]) {
    for (const file of [...globSync(join(corpusDir, `*.${ext}`)), ...globSync(join(corpusDir, `*/main.${ext}`))]) names.add(relative(corpusDir, file));
  }
  for (const driver of DRIVER_FIXTURES) names.delete(driver);
  return names.size;
}

async function runCorpus(context, plan) {
  const started = Date.now();
  const { options } = context;
  const step = { id: "corpus", ran: true, reds: [], passed: [], skipped: [], flaky: [], problems: [], shards: [], scope: { kind: "corpus", shardCount: options.shards, ranShards: [], completedShards: [] } };
  if (context.node26.executable === null) {
    step.problems.push({ id: "node26", message: context.node26.error });
    step.durationMs = Date.now() - started;
    step.headline = "did not run";
    return step;
  }
  const queue = [...plan.shards];
  const liveShards = new Map();
  const progress = setInterval(() => {
    const judged = step.shards.reduce((n, s) => n + s.passed + s.failed + s.skipped, 0);
    const live = [...liveShards.values()].map((s) => `${s.index}:${countResults(s.resultsPath)}`).join(" ");
    log(`corpus: ${judged} judged in ${step.shards.length} finished shards, running [${live}], ${formatDuration(Date.now() - started)} elapsed`);
  }, 60_000);
  progress.unref();
  const workers = Array.from({ length: Math.min(plan.jobs, queue.length) }, async () => {
    while (queue.length > 0 && !interrupted) {
      const shard = queue.shift();
      liveShards.set(shard.index, shard);
      const result = await runShard(context, shard);
      liveShards.delete(shard.index);
      step.shards.push(result);
      step.scope.ranShards.push(shard.index);
      if (result.completed) step.scope.completedShards.push(shard.index);
    }
  });
  await Promise.all(workers);
  clearInterval(progress);
  for (const shard of plan.shards) {
    if (!step.scope.ranShards.includes(shard.index)) step.problems.push({ id: `shard-${shard.index}`, message: `shard ${shard.index}/${shard.count} did not run (interrupted)` });
  }
  step.shards.sort((a, b) => a.index - b.index);
  step.scope.ranShards.sort((a, b) => a - b);
  step.scope.completedShards.sort((a, b) => a - b);
  for (const shard of step.shards) {
    for (const outcome of shard.outcomes) {
      if (outcome.state === "passed") {
        step.passed.push(outcome.name);
        if (outcome.flaky) step.flaky.push({ id: outcome.name, shard: shard.index, firstLines: outcome.errors[0] ?? "" });
      } else if (outcome.state === "failed") {
        step.reds.push({ id: outcome.name, shard: shard.index, durationMs: outcome.durationMs, firstLines: outcome.errors[0] ?? "(no error message)", retryCount: outcome.retryCount });
      } else if (outcome.state === "skipped") {
        step.skipped.push({ id: outcome.name, shard: shard.index, note: outcome.note });
      }
    }
    for (const problem of shard.problems) step.problems.push({ id: `shard-${shard.index}`, message: `shard ${shard.index}/${shard.count}: ${problem}` });
  }
  step.reds.sort((a, b) => (a.id < b.id ? -1 : 1));
  step.passed.sort();
  step.durationMs = Date.now() - started;
  const totals = {
    collected: step.shards.reduce((n, s) => n + s.collected, 0),
    passed: step.passed.length,
    failed: step.reds.length,
    skipped: step.skipped.length,
    missing: step.shards.reduce((n, s) => n + s.missing, 0),
    flaky: step.flaky.length,
    testTimeMs: step.shards.reduce((n, s) => n + s.testTimeMs, 0),
    peakBytesPerShard: Math.max(0, ...step.shards.map((s) => s.peakBytes ?? 0)) || null,
  };
  step.totals = totals;
  step.corpusProgramCount = corpusProgramCount();
  step.sample = options.sample !== null;
  const shardsText = options.sample === null ? `all ${options.shards} shards` : `shards ${options.sample.join(",")} of ${options.shards}`;
  step.headline = `${shardsText}, ${Math.min(plan.jobs, plan.shards.length)} at a time · ${totals.passed}/${totals.collected} claimed · ${totals.failed} failed · ${totals.skipped} skipped · ${totals.missing} did not run · ${totals.flaky} flaky · Σ test time ${formatDuration(totals.testTimeMs)} · peak ${totals.peakBytesPerShard ? `${(totals.peakBytesPerShard / 1024 ** 3).toFixed(1)} GB` : "n/a"}/shard`;
  return step;
}

function countResults(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith('{"type":"test"')).length;
  } catch {
    return 0;
  }
}

async function runShard(context, shard) {
  mkdirSync(shard.dir, { recursive: true });
  mkdirSync(shard.tmpDir, { recursive: true });
  log(`corpus: shard ${shard.index}/${shard.count} starting`);
  const run = await runChild({ ...shard, label: `corpus shard ${shard.index}/${shard.count}` });
  const digest = digestVitestResults(readJsonl(safeRead(shard.resultsPath)));
  const file = digest.files.find((entry) => entry.file === CORPUS_TEST_FILE) ?? { file: CORPUS_TEST_FILE, collected: [], suiteErrors: [], ended: false, state: null, errors: [] };
  const outcomes = digest.outcomes.filter((outcome) => outcome.file === CORPUS_TEST_FILE);
  const problems = [];
  const crashReason = describeCrash(run);
  const crashed = crashReason !== null;
  if (crashed) {
    problems.push(`crashed (${crashReason}) after ${outcomes.filter((o) => o.state !== "missing").length} of ${file.collected.length} programs; log ${shard.logPath}`);
  }
  // The exit status must be explained by the records: exit 1 with nothing recorded as failed, a
  // failing hook around the programs, or a module that failed for no recorded reason all mean the
  // verdict below would be taken on a stream that hides a failure.
  problems.push(...exitStatusProblems(run, digest).map((message) => `${message}; log ${shard.logPath}`));
  if (file.ended) {
    const found = moduleFindings(file, outcomes);
    for (const red of found.reds) problems.push(`suite-level failure outside any program (${red.id.replace(`${CORPUS_TEST_FILE} > `, "")}): ${baselineReason(red.firstLines)}`);
    problems.push(...found.problems);
  }
  if (digest.runEnd === null && !crashed) problems.push(`vitest ended without a run-end record (exit ${run.exitCode}); log ${shard.logPath}`);
  if (digest.runEnd?.reason === "interrupted") problems.push("vitest reported the run as interrupted");
  if ((digest.runEnd?.unhandledErrors ?? []).length > 0) problems.push(`${digest.runEnd.unhandledErrors.length} unhandled error(s): ${baselineReason(digest.runEnd.unhandledErrors[0])}`);
  if (file.collected.length === 0) problems.push(`collected no programs${file.errors?.length ? `: ${baselineReason(file.errors[0])}` : ""}; log ${shard.logPath}`);
  const missing = outcomes.filter((outcome) => outcome.state === "missing");
  if (missing.length > 0 && !crashed) problems.push(`${missing.length} program(s) did not run: ${missing.slice(0, 5).map((o) => o.name).join(", ")}${missing.length > 5 ? ", …" : ""}`);
  const executed = outcomes.filter((outcome) => outcome.state === "passed" || outcome.state === "failed").length;
  if (executed === 0 && file.collected.length > 0 && !crashed) problems.push(`none of the ${file.collected.length} collected programs executed (all skipped)`);
  const completed = !crashed && file.ended && problems.length === 0;
  if (!context.options.keepTmp) rmSync(shard.tmpDir, { recursive: true, force: true });
  const summary = {
    index: shard.index,
    count: shard.count,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    peakBytes: run.peakBytes,
    collected: file.collected.length,
    passed: outcomes.filter((o) => o.state === "passed").length,
    failed: outcomes.filter((o) => o.state === "failed").length,
    skipped: outcomes.filter((o) => o.state === "skipped").length,
    missing: missing.length,
    testTimeMs: outcomes.reduce((n, o) => n + (o.durationMs ?? 0), 0),
    parity: digest.parity?.line ?? null,
    completed,
    problems,
    log: shard.logPath,
    results: shard.resultsPath,
    outcomes,
  };
  log(`corpus: shard ${shard.index}/${shard.count} ${completed ? "finished" : "INCOMPLETE"}: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.missing} missing, ${formatDuration(run.durationMs)}${run.peakBytes ? `, peak ${(run.peakBytes / 1024 ** 3).toFixed(1)} GB` : ""}`);
  return summary;
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function focusFiles(context) {
  if (context.options.focusFiles.length > 0) {
    return { files: context.options.focusFiles.map((file) => (isAbsolute(file) ? relative(repoRoot, file) : file)), source: "--focus-file" };
  }
  const lanes = extractFocusLists(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
  return { files: lanes.node26.files, source: ".github/workflows/ci.yml (node_26_host)" };
}

/** One vitest process over a file list, hosted on `node`: how each focus lane is planned. */
function planFileLane(context, { id, target, node, list, extraEnv }) {
  const dir = join(context.outDir, id);
  const lane = { resultsPath: join(dir, "results.jsonl"), tmpDir: join(context.tmpBase, id) };
  const vitestFlags = [`--maxWorkers=${context.options.focusWorkers}`, "--reporter=default", `--reporter=${reporterPath}`];
  return {
    id,
    target,
    node,
    files: list.files,
    source: list.source,
    dir,
    logPath: join(dir, "vitest.log"),
    resultsPath: lane.resultsPath,
    tmpDir: lane.tmpDir,
    command: node.executable,
    vitestFlags,
    args: [vitestPath, "run", ...list.files, ...vitestFlags],
    cwd: repoRoot,
    timeoutMs: context.options.timeoutMin * 60_000,
    env: vitestEnv(context, lane, {
      SCRIPTC_NODE_ORACLE: node.executable ?? undefined,
      SCRIPTC_TEST_WORKERS: String(context.options.focusWorkers),
      ...extraEnv,
    }),
  };
}

function planFocus(context, target) {
  const node = target === "node26" ? context.node26 : context.node24;
  const id = `focus-${target}`;
  let list;
  try {
    list = focusFiles(context);
  } catch (error) {
    return { id, target, node, error: error.message, files: [] };
  }
  return planFileLane(context, { id, target, node, list, extraEnv: { SCRIPTC_RUNTIME_TARGET: target } });
}

async function runFileLane(context, plan) {
  const started = Date.now();
  const step = { id: plan.id, ran: true, target: plan.target, reds: [], passed: [], skipped: [], flaky: [], problems: [], files: [], scope: { kind: "files", files: plan.files, completedFiles: [] } };
  const finish = (headline) => {
    step.durationMs = Date.now() - started;
    step.headline = headline;
    return step;
  };
  if (plan.error) {
    step.problems.push({ id: "focus-list", message: plan.error });
    return finish("did not run: focus list unavailable");
  }
  if (plan.node.executable === null) {
    step.problems.push({ id: plan.target, message: plan.node.error });
    return finish(`did not run: ${plan.node.error}`);
  }
  const present = plan.files.filter((file) => existsSync(join(repoRoot, file)));
  for (const file of plan.files) {
    if (!present.includes(file)) step.problems.push({ id: file, message: `${plan.id} file ${file} does not exist` });
  }
  if (present.length === 0) {
    step.problems.push({ id: plan.id, message: `${plan.id} has no files to run` });
    return finish("did not run: no files");
  }
  mkdirSync(plan.dir, { recursive: true });
  mkdirSync(plan.tmpDir, { recursive: true });
  log(`${plan.id}: ${present.length} files on Node ${plan.node.version} (${plan.source})`);
  const run = await runChild({ ...plan, args: [vitestPath, "run", ...present, ...plan.vitestFlags], label: plan.id });
  const digest = digestVitestResults(readJsonl(safeRead(plan.resultsPath)));
  const crashReason = describeCrash(run);
  if (crashReason !== null) step.problems.push({ id: "vitest", message: `vitest did not complete (${crashReason}); log ${plan.logPath}` });
  // The exit status must be explained by the records (see exitStatusProblems).
  for (const message of exitStatusProblems(run, digest)) step.problems.push({ id: "vitest", message: `${message}; log ${plan.logPath}` });
  if ((digest.runEnd?.unhandledErrors ?? []).length > 0) step.problems.push({ id: "vitest", message: `${digest.runEnd.unhandledErrors.length} unhandled error(s): ${baselineReason(digest.runEnd.unhandledErrors[0])}` });
  for (const file of present) {
    const entry = digest.files.find((candidate) => candidate.file === file);
    const outcomes = digest.outcomes.filter((outcome) => outcome.file === file);
    const executed = outcomes.filter((o) => o.state === "passed" || o.state === "failed");
    const missing = outcomes.filter((o) => o.state === "missing");
    const record = { file, collected: entry?.collected.length ?? 0, passed: executed.filter((o) => o.state === "passed").length, failed: executed.filter((o) => o.state === "failed").length, skipped: outcomes.filter((o) => o.state === "skipped").length, missing: missing.length, durationMs: entry?.durationMs ?? null, state: entry?.state ?? "missing" };
    step.files.push(record);
    if (entry === undefined || !entry.ended) {
      step.problems.push({ id: file, message: `${file} did not run${entry?.errors?.length ? `: ${baselineReason(entry.errors[0])}` : ""}` });
      continue;
    }
    // Module-level errors and failing suite hooks are reds of their own; a module that failed
    // for no recorded reason is a problem, and a file with a problem is not "completed", so
    // its baseline entries are left alone rather than judged on an unreliable record.
    const found = moduleFindings(entry, outcomes);
    step.reds.push(...found.reds);
    for (const message of found.problems) step.problems.push({ id: file, message });
    const failedBeforeCollecting = entry.state === "failed" && entry.collected.length === 0;
    if (!failedBeforeCollecting && executed.length === 0) {
      step.problems.push({ id: file, message: `${file} executed no test (${entry.collected.length} collected, ${record.skipped} skipped)` });
      continue;
    }
    if (missing.length > 0) step.problems.push({ id: file, message: `${file}: ${missing.length} test(s) did not run` });
    else if (found.problems.length === 0) step.scope.completedFiles.push(file);
    for (const outcome of outcomes) {
      const id = `${file} > ${outcome.fullName ?? outcome.name}`;
      if (outcome.state === "passed") {
        step.passed.push(id);
        if (outcome.flaky) step.flaky.push({ id, firstLines: outcome.errors[0] ?? "" });
      } else if (outcome.state === "failed") {
        step.reds.push({ id, durationMs: outcome.durationMs, firstLines: outcome.errors[0] ?? "(no error message)", retryCount: outcome.retryCount });
      } else if (outcome.state === "skipped") {
        step.skipped.push({ id, note: outcome.note });
      }
    }
  }
  if (!context.options.keepTmp) rmSync(plan.tmpDir, { recursive: true, force: true });
  step.run = { exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut, durationMs: run.durationMs, peakBytes: run.peakBytes, log: plan.logPath, results: plan.resultsPath };
  const tests = step.passed.length + step.reds.length;
  return finish(`${present.length} files on Node ${plan.node.version}, target ${plan.target} · ${tests} tests · ${step.reds.length} failed · ${step.skipped.length} skipped · ${step.flaky.length} flaky${run.peakBytes ? ` · peak ${(run.peakBytes / 1024 ** 3).toFixed(1)} GB` : ""}`);
}

// ---- main -------------------------------------------------------------------------

function defaultOutDir(mode) {
  const cacheRoot = process.env["XDG_CACHE_HOME"] ?? (process.platform === "win32" ? process.env["LOCALAPPDATA"] ?? homedir() : join(homedir(), ".cache"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  return join(cacheRoot, "scriptc", "gate-rust", `${stamp}-${mode}`);
}

function tmpBaseFor(runTag) {
  const base = process.env["TMPDIR"] ?? join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "scriptc", "test-tmp");
  // Short on purpose: corpus programs bind unix sockets under TMPDIR, and
  // sun_path tops out near one hundred bytes.
  return join(base, `gr-${runTag}`);
}

function extrapolation(step) {
  if (!step?.ran || !step.sample || step.totals.collected === 0) return null;
  const perProgramMs = step.totals.testTimeMs / step.totals.collected;
  const sequentialMs = perProgramMs * step.corpusProgramCount;
  const jobs = Math.max(1, step.jobs ?? 1);
  const text = `sample ${step.totals.collected} of ${step.corpusProgramCount} programs at ${(perProgramMs / 1000).toFixed(2)} s/program → sequential ≈ ${formatDuration(sequentialMs)}; at ${jobs} shard${jobs === 1 ? "" : "s"} in parallel ≈ ${formatDuration(sequentialMs / jobs)}–${formatDuration(sequentialMs / (jobs * 0.6))} (60–100% scaling, excluding cold runtime builds and shard startup; the sample's program mix sets the error bar)`;
  return { perProgramMs, sequentialMs, jobs, text };
}

async function main() {
  const argv = process.argv.slice(2);
  let options;
  try {
    options = parseArgs(argv, hostInfo());
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const startedAt = new Date();
  const host = hostInfo();
  const repo = repoInfo();
  const outDir = resolve(options.out ?? defaultOutDir(options.mode));
  const runTag = basename(outDir).replace(/[^A-Za-z0-9]/g, "").slice(-8) || String(process.pid);
  const toolchain = options.toolchain ?? pinnedToolchain();
  const node26 = resolveNode("node26", NODE26_VERSION, options.node26, process.env);
  const node24 = resolveNode("node24", NODE24_VERSION, options.node24, process.env);
  const baselinePath = resolve(repoRoot, options.baseline);
  let baseline;
  try {
    baseline = existsSync(baselinePath) ? normalizeBaseline(JSON.parse(readFileSync(baselinePath, "utf8")), baselinePath) : emptyBaseline();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.rejudge !== null) return rejudge(options, baseline, baselinePath, outDir, startedAt, repo);
  const context = { options, outDir, tmpBase: tmpBaseFor(runTag), toolchain, node26, node24 };
  const plans = {
    "runtime-crate": () => planRuntimeCrate(context),
    corpus: () => planCorpus(context),
    "focus-node26": () => planFocus(context, "node26"),
    "focus-node24": () => planFocus(context, "node24"),
  };
  if (options.dryRun) {
    const plan = { mode: options.mode, outDir, toolchain, node26, node24, jobs: options.jobs, steps: options.selectedSteps.map((id) => plans[id]()) };
    process.stdout.write(`${JSON.stringify(plan, (key, value) => (key === "env" && value && typeof value === "object" ? envDelta(value) : value), 2)}\n`);
    return 0;
  }
  mkdirSync(outDir, { recursive: true });
  mkdirSync(context.tmpBase, { recursive: true });
  log(`mode ${options.mode}; report in ${outDir}; toolchain ${toolchain}; Node 26 ${node26.executable ?? `unavailable (${node26.error})`}; Node 24 ${node24.executable ?? `unavailable (${node24.error})`}`);
  const steps = [];
  for (const id of options.selectedSteps) {
    const plan = plans[id]();
    const stepStarted = Date.now();
    log(`step ${id} starting`);
    let step;
    try {
      step = id === "runtime-crate" ? await runRuntimeCrate(context, plan) : id === "corpus" ? await runCorpus(context, plan) : await runFileLane(context, plan);
      if (id === "corpus") step.jobs = plan.jobs;
    } catch (error) {
      step = { id, ran: true, reds: [], passed: [], skipped: [], problems: [{ id: "gate", message: `gate failure: ${error.stack ?? error.message}` }], scope: { kind: "none" }, durationMs: Date.now() - stepStarted, headline: "gate failure" };
    }
    steps.push(step);
    // Counts, not a verdict: whether a red is new is decided against the baseline at the end.
    log(`step ${id} finished in ${formatDuration(step.durationMs)} with ${step.reds.length} red(s), ${step.problems.length} problem(s): ${step.headline}`);
    if (interrupted) break;
  }
  for (const id of ["runtime-crate", "corpus", "focus-node26", "focus-node24"]) {
    if (!steps.some((step) => step.id === id)) steps.push({ id, ran: false, reds: [], passed: [], skipped: [], problems: [], scope: { kind: "none" }, durationMs: null, skippedReason: interrupted && options.selectedSteps.includes(id) ? "interrupted" : options.quick && !options.selectedSteps.includes(id) ? "quick mode" : "not selected" });
  }
  const orderedSteps = ["runtime-crate", "corpus", "focus-node26", "focus-node24"].map((id) => steps.find((step) => step.id === id));
  if (interrupted) orderedSteps[0].problems.push({ id: "interrupted", message: "the gate was interrupted before every selected step finished" });
  const verdict = evaluate(orderedSteps, baseline, { repoRoot, commit: repo.commit, date: startedAt.toISOString().slice(0, 10) });
  const finishedAt = new Date();
  const paths = { report: join(outDir, "report.json"), summary: join(outDir, "summary.txt"), outDir };
  const report = {
    schema: REPORT_SCHEMA,
    tool: "gate-rust",
    mode: options.mode,
    argv,
    options,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    repo,
    host: { ...host, loadavgEnd: loadavg().map((v) => Number(v.toFixed(2))) },
    toolchain: { pin: toolchain, node26, node24 },
    steps: orderedSteps,
    extrapolation: extrapolation(orderedSteps[1]),
    baseline: baselineSummary(baselinePath, baseline, options),
    verdict,
    paths,
  };
  if (options.updateBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(verdict.nextBaseline, null, 2)}\n`);
    log(`baseline rewritten: ${baselinePath}`);
  }
  const summary = renderSummary(report);
  writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(paths.summary, summary);
  try {
    const latest = join(dirname(outDir), "latest");
    rmSync(latest, { force: true });
    symlinkSync(outDir, latest);
  } catch {
    // The latest pointer is a convenience, never a failure.
  }
  rmSync(context.tmpBase, { recursive: true, force: true });
  process.stdout.write(summary);
  if (options.updateBaseline) return verdict.problems.length === 0 ? 0 : 1;
  return verdict.exitCode;
}

/** Re-run the verdict of an earlier report against the baseline as it is
 * now: the way to turn a long calibration run into a baseline after the
 * fact, or to check an edited baseline without recompiling anything. */
function rejudge(options, baseline, baselinePath, outDir, startedAt, repo) {
  let previous;
  try {
    previous = JSON.parse(readFileSync(resolve(options.rejudge), "utf8"));
  } catch (error) {
    process.stderr.write(`cannot read ${options.rejudge}: ${error.message}\n`);
    return 2;
  }
  if (previous?.tool !== "gate-rust" || !Array.isArray(previous.steps)) {
    process.stderr.write(`${options.rejudge} is not a gate-rust report\n`);
    return 2;
  }
  const verdict = evaluate(previous.steps, baseline, { repoRoot, commit: previous.repo?.commit ?? repo.commit, date: (previous.startedAt ?? startedAt.toISOString()).slice(0, 10) });
  mkdirSync(outDir, { recursive: true });
  const paths = { report: join(outDir, "report.json"), summary: join(outDir, "summary.txt"), outDir };
  const report = {
    ...previous,
    mode: "rejudge",
    rejudgeOf: resolve(options.rejudge),
    argv: process.argv.slice(2),
    options,
    finishedAt: new Date().toISOString(),
    baseline: baselineSummary(baselinePath, baseline, options),
    verdict,
    paths,
  };
  if (options.updateBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(verdict.nextBaseline, null, 2)}\n`);
    log(`baseline rewritten: ${baselinePath}`);
  }
  const summary = renderSummary(report);
  writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(paths.summary, summary);
  process.stdout.write(summary);
  if (options.updateBaseline) return verdict.problems.length === 0 ? 0 : 1;
  return verdict.exitCode;
}

function baselineSummary(baselinePath, baseline, options) {
  const rel = relative(repoRoot, baselinePath);
  return {
    path: rel.startsWith("..") ? baselinePath : rel,
    known: Object.values(baseline.reds).reduce((n, entries) => n + Object.keys(entries).length, 0),
    updated: options.updateBaseline,
  };
}

function envDelta(env) {
  const delta = {};
  for (const [name, value] of Object.entries(env)) if (process.env[name] !== value) delta[name] = value;
  for (const name of Object.keys(process.env)) if (!(name in env)) delta[name] = null;
  return delta;
}

process.exitCode = await main();
