/* The pure half of scripts/gate-rust.mjs: option parsing, the CI focus-list
 * extraction, result digestion, the baseline verdict and the summary text.
 * Nothing here spawns a process or touches the file system, so
 * tests/harness/gate-rust.test.ts can pin every rule on synthetic input
 * without compiling a single corpus program. */
import yaml from "js-yaml";
import { shardOf } from "../tests/harness/shard.js";
import { firstLines } from "./gate-rust-reporter.mjs";

export const STEP_IDS = ["runtime-crate", "corpus", "focus-node26", "focus-node24"];
export const QUICK_STEP_IDS = ["runtime-crate", "corpus", "focus-node26"];
export const QUICK_SHARDS = 40;
export const QUICK_SAMPLE = [1, 21];
export const BASELINE_SCHEMA = 1;
export const REPORT_SCHEMA = 1;
export const DEFAULT_BASELINE = "tests/dogfood/rust-gate-baseline.json";
export const CORPUS_TEST_FILE = "tests/harness/rust-differential.test.ts";

export class UsageError extends Error {}

export const USAGE = `usage: pnpm gate:rust [options]

Rust-scoped validation gate: the runtime crate's own gate, the strict Rust
corpus differential split into shard processes, and CI's focused Rust
regression list on Node 26 (target node26) and Node 24 (target node24).
Every step runs even when an earlier one fails; the verdict compares the
reds against the committed baseline.
Only one gate (or full suite) runs at a time per temporary directory: it
takes the same advisory lock as a full 'pnpm test'.

  --quick                 runtime crate + corpus shards ${QUICK_SAMPLE.join(",")} of ${QUICK_SHARDS} + focus list on Node 26 only
  --steps <ids>           comma-separated subset of: ${STEP_IDS.join(", ")}
  --skip <ids>            steps to leave out
  --shards <n>            corpus shard count (default 16; quick mode ${QUICK_SHARDS})
  --sample <i,j,...>      run only these shard indices (1-based) of --shards
  --jobs <n>              shard processes running at once (default: host-derived)
  --focus-workers <n>     vitest workers for each focus lane (default 2)
  --focus-file <path>     replace the CI focus list (repeatable)
  --timeout-min <n>       wall-clock cap per child process (default 90)
  --out <dir>             report directory (default: <cache>/scriptc/gate-rust/<stamp>-<mode>)
  --baseline <file>       known reds (default ${DEFAULT_BASELINE})
  --update-baseline       rewrite the baseline from this run's reds
  --rejudge <report.json> re-evaluate an earlier run's report against the baseline instead of running
  --node26 <path>         Node 26 interpreter (else SCRIPTC_NODE_NODE26, host, mise)
  --node24 <path>         Node 24 interpreter (else SCRIPTC_NODE_NODE24, host, mise)
  --toolchain <name>      RUSTUP_TOOLCHAIN for every step (default: packages/runtime-rust/rust-toolchain.toml)
  --isolate-cache         give each corpus shard its own SCRIPTC_CACHE_DIR (cold runtime build per shard)
  --keep-binaries         keep passed corpus binaries (default discards them to bound disk use)
  --keep-tmp              keep per-shard TMPDIRs
  --strict-reasons        also fail when a known red fails differently than the baseline recorded
  --no-lock               do not take the advisory lock (same as SCRIPTC_NO_LOCK=1)
  --lock-wait-min <n>     wait this long for the lock before refusing to start (default 45)
  --dry-run               print the plan (commands and environment deltas) and exit
  --help                  this text
`;

function parseInteger(flag, raw, minimum = 1) {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < minimum) {
    throw new UsageError(`${flag} expects an integer >= ${minimum}, got '${raw ?? ""}'`);
  }
  return value;
}

function parseList(flag, raw) {
  if (raw === undefined || raw === "") throw new UsageError(`${flag} expects a comma-separated list`);
  return raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

/** Parse the CLI into a fully resolved option object. Pure: host-derived
 * defaults (jobs) are filled in by the caller through `host`, and the
 * environment arrives as `env` so the unit tests stay hermetic. */
export function parseArgs(argv, host = { cpus: 1, memoryGb: 0 }, env = {}) {
  const options = {
    quick: false,
    steps: null,
    skip: [],
    shards: null,
    sample: null,
    jobs: null,
    focusWorkers: 2,
    focusFiles: [],
    timeoutMin: 90,
    out: null,
    baseline: DEFAULT_BASELINE,
    updateBaseline: false,
    rejudge: null,
    node26: null,
    node24: null,
    toolchain: null,
    isolateCache: false,
    keepBinaries: false,
    keepTmp: false,
    strictReasons: false,
    noLock: env["SCRIPTC_NO_LOCK"] === "1",
    lockWaitMin: 45,
    dryRun: false,
    help: false,
    warnings: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // `pnpm gate:rust -- --quick` hands the separator through on some pnpm majors.
    if (arg === "--") continue;
    const [flag, inlineValue] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new UsageError(`${flag} expects a value`);
      return argv[i];
    };
    switch (flag) {
      case "--quick": options.quick = true; break;
      case "--steps": options.steps = parseList(flag, takeValue()); break;
      case "--skip": options.skip = parseList(flag, takeValue()); break;
      case "--shards": options.shards = parseInteger(flag, takeValue()); break;
      case "--sample": options.sample = parseList(flag, takeValue()).map((item) => parseInteger("--sample", item)); break;
      case "--jobs": options.jobs = parseInteger(flag, takeValue()); break;
      case "--focus-workers": options.focusWorkers = parseInteger(flag, takeValue()); break;
      case "--focus-file": options.focusFiles.push(takeValue()); break;
      case "--timeout-min": options.timeoutMin = parseInteger(flag, takeValue()); break;
      case "--out": options.out = takeValue(); break;
      case "--baseline": options.baseline = takeValue(); break;
      case "--update-baseline": options.updateBaseline = true; break;
      case "--rejudge": options.rejudge = takeValue(); break;
      case "--node26": options.node26 = takeValue(); break;
      case "--node24": options.node24 = takeValue(); break;
      case "--toolchain": options.toolchain = takeValue(); break;
      case "--isolate-cache": options.isolateCache = true; break;
      case "--keep-binaries": options.keepBinaries = true; break;
      case "--keep-tmp": options.keepTmp = true; break;
      case "--strict-reasons": options.strictReasons = true; break;
      case "--no-lock": options.noLock = true; break;
      case "--lock-wait-min": options.lockWaitMin = parseInteger(flag, takeValue(), 0); break;
      case "--dry-run": options.dryRun = true; break;
      case "--help": case "-h": options.help = true; break;
      default: throw new UsageError(`unknown argument '${arg}'`);
    }
  }
  for (const id of [...(options.steps ?? []), ...options.skip]) {
    if (!STEP_IDS.includes(id)) throw new UsageError(`unknown step '${id}' (expected one of ${STEP_IDS.join(", ")})`);
  }
  const requested = options.steps ?? (options.quick ? QUICK_STEP_IDS : STEP_IDS);
  options.selectedSteps = STEP_IDS.filter((id) => requested.includes(id) && !options.skip.includes(id));
  options.shards ??= options.quick ? QUICK_SHARDS : 16;
  if (options.quick && options.sample === null) {
    options.sample = QUICK_SAMPLE.filter((index) => index <= options.shards);
    if (options.sample.length < QUICK_SAMPLE.length) {
      options.warnings.push(`--quick samples shards ${QUICK_SAMPLE.join(",")} of ${QUICK_SHARDS}; with --shards ${options.shards} only shard${options.sample.length === 1 ? "" : "s"} ${options.sample.join(",")} fit, so the sample is smaller than in a plain --quick run (pass --sample to choose)`);
    }
  }
  if (options.sample !== null) {
    for (const index of options.sample) {
      if (index > options.shards) throw new UsageError(`--sample index ${index} exceeds --shards ${options.shards}`);
    }
    options.sample = [...new Set(options.sample)].sort((a, b) => a - b);
  }
  options.jobs ??= defaultJobs(host);
  options.mode = options.rejudge !== null ? "rejudge" : options.quick ? "quick" : (options.steps !== null || options.skip.length > 0 || options.sample !== null ? "custom" : "full");
  return options;
}

/** Shard processes to run at once: one per three cores and one per four
 * gigabytes, whichever binds — a shard carries a vitest worker holding
 * TypeScript programs, one rustc and two running programs. */
export function defaultJobs(host) {
  const byCpu = Math.floor((host.cpus ?? 1) / 3);
  const byMemory = Math.floor((host.memoryGb ?? 0) / 4);
  return Math.max(1, Math.min(byCpu, byMemory));
}

/** A full corpus run (no sample, every shard completed) must account for
 * every corpus program: the shards partition the corpus by name hash, so
 * their collected counts have to add up to the program count, and a shard
 * count that dropped or duplicated programs would make "all shards green"
 * mean less than it says. Null when the check does not apply or holds. */
export function corpusTotalProblem({ sample, shards, completedShards, collected, expected }) {
  if (sample !== null || completedShards.length !== shards) return null;
  if (collected === expected) return null;
  return `the ${shards} shards collected ${collected} programs but the corpus directory holds ${expected}`;
}

/** The shard indices a corpus run executes. */
export function corpusShardIndices(options) {
  return options.sample ?? Array.from({ length: options.shards }, (_, i) => i + 1);
}

// ---- CI focus list ----------------------------------------------------------

/** The focused Rust regression list lives in .github/workflows/ci.yml, in
 * the node_26_host job: one `pnpm exec vitest run <files…>` step per
 * target. The gate reads that job rather than keeping its own copy, so the
 * list has one home; the two steps must name the same files. */
export function extractFocusLists(workflowText) {
  const workflow = yaml.load(workflowText);
  const job = workflow?.jobs?.node_26_host;
  if (job === undefined) throw new Error("ci.yml has no node_26_host job");
  const lanes = {};
  for (const step of job.steps ?? []) {
    const target = step.env?.SCRIPTC_RUNTIME_TARGET;
    if (typeof step.run !== "string" || (target !== "node26" && target !== "node24")) continue;
    const tokens = step.run.replace(/\s+/g, " ").trim().split(" ");
    const start = tokens.indexOf("run");
    if (tokens[0] !== "pnpm" || tokens[1] !== "exec" || tokens[2] !== "vitest" || start !== 3) {
      throw new Error(`node_26_host step '${step.name}' is not a plain 'pnpm exec vitest run' command`);
    }
    const files = tokens.slice(4).filter((token) => !token.startsWith("-"));
    const flags = tokens.slice(4).filter((token) => token.startsWith("-"));
    if (lanes[target] !== undefined) throw new Error(`node_26_host has two vitest steps for ${target}`);
    lanes[target] = { name: step.name, files, flags };
  }
  for (const target of ["node26", "node24"]) {
    if (lanes[target] === undefined) throw new Error(`node_26_host has no vitest step with SCRIPTC_RUNTIME_TARGET=${target}`);
  }
  const a = lanes.node26.files.join("\n");
  const b = lanes.node24.files.join("\n");
  if (a !== b) {
    throw new Error("the node26 and node24 focus lists in ci.yml differ; they must name the same files in the same order");
  }
  return lanes;
}

// ---- vitest JSONL digestion -------------------------------------------------

export function readJsonl(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A line cut short by a crash is the one record we cannot read.
    }
  }
  return records;
}

/** Fold the reporter's event stream into per-file test outcomes. A test
 * that has a module-collected entry but no test record "did not run".
 * Names repeat within a file (test.each over dev and release emits one
 * title per row), so collection and results are compared as multisets. */
export function digestVitestResults(records) {
  const files = new Map();
  const file = (name) => {
    let entry = files.get(name);
    if (entry === undefined) {
      entry = { file: name, collected: [], tests: [], suiteErrors: [], ended: false, state: null, errors: [], durationMs: null };
      files.set(name, entry);
    }
    return entry;
  };
  let parity = null;
  let runEnd = null;
  let runStart = null;
  for (const record of records) {
    switch (record.type) {
      case "run-start": runStart = record; break;
      case "module-collected": file(record.file).collected.push(...record.tests); break;
      case "test": file(record.file).tests.push(record); break;
      case "suite": file(record.file).suiteErrors.push({ name: record.name, fullName: record.fullName ?? record.name, state: record.state, errors: record.errors ?? [] }); break;
      case "module-end": {
        const entry = file(record.file);
        entry.ended = true;
        entry.state = record.state;
        entry.errors = record.errors ?? [];
        entry.durationMs = record.durationMs ?? null;
        break;
      }
      case "console": {
        const match = /rust parity: (\d+)\/(\d+) corpus programs claimed(.*)/s.exec(record.content);
        if (match) parity = { claimed: Number(match[1]), total: Number(match[2]), line: record.content.split("\n")[0] };
        break;
      }
      case "run-end": runEnd = record; break;
      default: break;
    }
  }
  const outcomes = [];
  for (const entry of files.values()) {
    const pending = new Map();
    for (const name of entry.collected) pending.set(name, (pending.get(name) ?? 0) + 1);
    for (const test of entry.tests) {
      pending.set(test.name, (pending.get(test.name) ?? 0) - 1);
      outcomes.push({
        file: entry.file,
        name: test.name,
        fullName: test.fullName,
        state: test.state,
        durationMs: test.durationMs,
        retryCount: test.retryCount ?? 0,
        flaky: test.flaky === true,
        note: test.note ?? null,
        errors: test.errors ?? [],
      });
    }
    for (const [name, count] of pending) {
      for (let i = 0; i < count; i += 1) {
        outcomes.push({ file: entry.file, name, fullName: null, state: "missing", durationMs: null, retryCount: 0, flaky: false, note: null, errors: [] });
      }
    }
  }
  const all = [...files.values()];
  const evidence = {
    failedTests: outcomes.filter((outcome) => outcome.state === "failed").length,
    suiteErrors: all.reduce((n, entry) => n + entry.suiteErrors.length, 0),
    moduleErrors: all.reduce((n, entry) => n + entry.errors.length, 0),
    failedModules: all.filter((entry) => entry.state === "failed").length,
    unhandled: runEnd?.unhandledErrors?.length ?? 0,
  };
  return { files: all, outcomes, parity, runStart, runEnd, evidence };
}

/** Why a child process counts as crashed, or null when it ran to a verdict:
 * a spawn error, the wall-clock cap, a signal, or any exit status other than
 * vitest's 0 (green) and 1 (red). */
export function describeCrash(run) {
  if (run.spawnError) return run.spawnError;
  if (run.timedOut) return `timed out after ${formatDuration(run.durationMs)}`;
  if (run.signal) return `signal ${run.signal}`;
  if (run.exitCode !== 0 && run.exitCode !== 1) return `exit code ${run.exitCode}`;
  return null;
}

/** Cross-check a vitest child's exit status against the records it left.
 * Exit 1 with nothing recorded that failed means vitest saw a failure the
 * reporter did not (a hook error, a worker error): the gate must not read
 * that as green. The reverse, exit 0 with recorded failures, means the
 * stream and the process disagree. */
export function exitStatusProblems(run, digest) {
  if (describeCrash(run) !== null) return [];
  const { evidence } = digest;
  const recorded = evidence.failedTests + evidence.suiteErrors + evidence.moduleErrors + evidence.unhandled;
  if (run.exitCode === 1 && recorded === 0) {
    const modules = evidence.failedModules > 0 ? `; ${evidence.failedModules} module(s) ended in state 'failed'` : "";
    return [`vitest exited 1 but recorded no failing test, suite hook error, module error or unhandled error${modules}`];
  }
  if (run.exitCode === 0 && recorded > 0) return [`vitest exited 0 but recorded ${recorded} failure record(s)`];
  return [];
}

/** What a vitest module's own records imply beyond its test outcomes: a
 * module-level error (an import that throws, a module-level hook) and a
 * suite-level hook error are reds keyed by file or suite; a module that
 * ended in state 'failed' with no failing test, suite error or module error
 * behind it is a problem, because its failure is unexplained. */
export function moduleFindings(entry, outcomes) {
  const reds = [];
  const problems = [];
  if (entry.errors.length > 0) reds.push({ id: entry.file, firstLines: entry.errors[0] });
  for (const suite of entry.suiteErrors) {
    reds.push({ id: `${entry.file} > ${suite.fullName} [suite hook failed]`, firstLines: suite.errors[0] ?? "(no error message)" });
  }
  const explained = entry.errors.length + entry.suiteErrors.length + outcomes.filter((outcome) => outcome.state === "failed").length;
  if (entry.state === "failed" && explained === 0) {
    problems.push(`${entry.file} ended in state 'failed' with no recorded failing test, suite hook error or module error`);
  }
  return { reds, problems };
}

// ---- cargo output -----------------------------------------------------------

/** Per-test outcomes from a `cargo test` log that merged stdout and stderr
 * in order: `Running …` lines label the binary, `test X ... ok|FAILED`
 * lines carry the outcome, `---- X stdout ----` blocks hold the failure.
 * A binary whose `Running` line is never followed by a `test result:` line
 * crashed (abort, SIGSEGV, killed) and is reported as such, and
 * `error: test failed, to rerun pass …` lines are counted so the caller can
 * tell a failure the per-test lines do not explain. */
export function parseCargoTestLog(text) {
  const lines = text.split("\n");
  const counts = { passed: 0, failed: 0, ignored: 0 };
  const binaries = [];
  const failures = [];
  const passed = [];
  const failureDetail = new Map();
  const targets = [];
  let current = null;
  let binary = "";
  let summaries = 0;
  let failedTargetLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m;
    if ((m = /^\s*Running (?:unittests |tests )?(\S+) \(/.exec(line))) {
      binary = m[1];
      binaries.push(binary);
      current = { name: binary, summarised: false };
      targets.push(current);
    } else if ((m = /^\s*Doc-tests (\S+)/.exec(line))) {
      binary = `doc:${m[1]}`;
      binaries.push(binary);
      current = { name: binary, summarised: false };
      targets.push(current);
    } else if (/^error: (?:test|doctest) failed, to rerun pass/.test(line)) {
      failedTargetLines += 1;
    } else if ((m = /^test (\S+)(?: - .+?)? \.\.\. (ok|FAILED|ignored)/.exec(line))) {
      const record = { id: `cargo-test::${binary}::${m[1]}`, name: m[1], binary };
      if (m[2] === "FAILED") failures.push(record);
      else if (m[2] === "ok") passed.push(record);
    } else if ((m = /^---- (\S+) stdout ----$/.exec(line))) {
      const detail = [];
      for (let j = i + 1; j < lines.length && detail.length < 8; j += 1) {
        if (lines[j].startsWith("---- ") || lines[j] === "failures:") break;
        if (lines[j].trim() !== "") detail.push(lines[j]);
      }
      failureDetail.set(`${binary}::${m[1]}`, detail.join("\n"));
    } else if ((m = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line))) {
      summaries += 1;
      if (current !== null) current.summarised = true;
      counts.passed += Number(m[2]);
      counts.failed += Number(m[3]);
      counts.ignored += Number(m[4]);
    }
  }
  for (const failure of failures) {
    failure.firstLines = firstLines(failureDetail.get(`${failure.binary}::${failure.name}`) ?? "(no captured output)");
  }
  const errorLines = lines.filter((line) => /^error(\[E\d+\])?:/.test(line));
  const crashedBinaries = targets.filter((target) => !target.summarised).map((target) => target.name);
  return { counts, binaries, failures, passed, summaries, crashedBinaries, failedTargetLines, errorLines: errorLines.slice(0, 10) };
}

/** Clippy under -D warnings: every lint is an `error:` diagnostic, and each
 * becomes its own record keyed by lint and file (not line, so a diagnostic
 * that merely moves keeps its id), with a `#2`, `#3` suffix for repeats of
 * one lint in one file so an added occurrence is a new red. The lint name
 * comes from the "`-D <lint>` implied by `-D warnings`" note; an error
 * without one (a hard compile error) is keyed by its error code or message.
 * An identical diagnostic printed for two targets counts once. */
export function parseClippyLog(text) {
  const lines = text.split("\n");
  const diagnostics = [];
  const seen = new Set();
  const perKey = new Map();
  const isStart = (line) => /^(error|warning)(\[\w+\])?: /.test(line);
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^error(?:\[(\w+)\])?: (.*)$/.exec(lines[i]);
    if (!head) continue;
    const message = head[2];
    if (/^could not compile |^aborting due to |^process didn't exit successfully/.test(message)) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && !isStart(lines[j]) && block.length < 60; j += 1) block.push(lines[j]);
    const location = block.map((line) => /^\s*--> (\S+?)(?::(\d+):(\d+))?\s*$/.exec(line)).find(Boolean) ?? null;
    const note = block.map((line) => /`-D ([\w:-]+)` implied by `-D warnings`/.exec(line)).find(Boolean) ?? null;
    const file = location ? location[1] : null;
    const where = location ? `${location[1]}${location[2] ? `:${location[2]}:${location[3]}` : ""}` : null;
    const lint = note ? note[1] : head[1] ? `rustc::${head[1]}` : "unclassified";
    const fingerprint = `${lint}|${where ?? ""}|${message}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const slug = message.replace(/`[^`]*`/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
    const key = `${lint}::${file ?? slug}`;
    const ordinal = (perKey.get(key) ?? 0) + 1;
    perKey.set(key, ordinal);
    diagnostics.push({
      id: `cargo-clippy::${key}${ordinal > 1 ? `#${ordinal}` : ""}`,
      lint,
      file,
      message: `error: ${message}`,
      location: where,
      firstLines: where ? `error: ${message}\n  --> ${where}` : `error: ${message}`,
    });
  }
  return {
    errorCount: diagnostics.length,
    diagnostics,
    firstLines: firstLines(diagnostics.slice(0, 8).map((d) => (d.location ? `${d.message} (${d.location})` : d.message)).join("\n"), 8, 1600),
  };
}

// ---- baseline ---------------------------------------------------------------

export function emptyBaseline() {
  return { schema: BASELINE_SCHEMA, reds: {}, calibration: {} };
}

/** Validate a parsed baseline file; a malformed file is a usage error
 * rather than an empty baseline, because an empty baseline turns every
 * known red into a new one. */
export function normalizeBaseline(parsed, path = "baseline") {
  if (parsed === null || typeof parsed !== "object") throw new UsageError(`${path} is not a JSON object`);
  if (parsed.schema !== BASELINE_SCHEMA) throw new UsageError(`${path} has schema ${parsed.schema}, expected ${BASELINE_SCHEMA}`);
  const reds = {};
  for (const [step, entries] of Object.entries(parsed.reds ?? {})) {
    if (!STEP_IDS.includes(step)) throw new UsageError(`${path} lists reds for unknown step '${step}'`);
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) throw new UsageError(`${path}: reds.${step} must be an object of id → reason`);
    reds[step] = { ...entries };
  }
  return { schema: BASELINE_SCHEMA, reds, calibration: { ...(parsed.calibration ?? {}) } };
}

/** Whether a baseline id was verifiable by a step's run, given its scope. */
export function inScope(scope, id) {
  switch (scope.kind) {
    case "none": return false;
    case "all": return true;
    case "corpus": return scope.completedShards.includes(shardOf(id, scope.shardCount));
    case "files": {
      const file = scope.files.find((candidate) => id === candidate || id.startsWith(`${candidate} > `));
      return file !== undefined && scope.completedFiles.includes(file);
    }
    case "cargo": {
      if (id === "cargo-clippy") return scope.clippyRan;
      if (id.startsWith("cargo-clippy::")) return scope.clippyRan && (scope.clippyResultsParsed ?? true);
      if (id === "cargo-test") return scope.testRan;
      if (id.startsWith("cargo-test::")) return scope.testRan && scope.testResultsParsed;
      return false;
    }
    default: return false;
  }
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The verdict: new reds and infrastructure problems fail the gate; known
 * reds pass; baseline entries that now pass or no longer exist are listed
 * for removal. `steps` is the orchestrator's per-step result list. */
export function evaluate(steps, baseline, context = {}) {
  const newReds = [];
  const stillRed = [];
  const reasonChanged = [];
  const flaky = [];
  const flakyKnown = [];
  const fixed = [];
  const stale = [];
  const skippedKnown = [];
  const notChecked = [];
  const problems = [];
  const nextReds = {};
  const nextCalibration = { ...baseline.calibration };
  for (const id of STEP_IDS) {
    const known = baseline.reds[id] ?? {};
    const step = steps.find((candidate) => candidate.id === id);
    if (step === undefined || !step.ran) {
      for (const entry of Object.keys(known)) notChecked.push({ step: id, id: entry });
      if (Object.keys(known).length > 0) nextReds[id] = sortedObject(Object.entries(known));
      continue;
    }
    const redIds = new Set(step.reds.map((red) => red.id));
    const passedIds = new Set(step.passed);
    const passedPrefixes = step.passedPrefixes ?? [];
    const flakyIds = new Set((step.flaky ?? []).map((entry) => entry.id));
    const skippedIds = new Set(step.skipped.map((entry) => entry.id));
    const kept = {};
    for (const entry of step.flaky ?? []) flaky.push({ step: id, id: entry.id, firstLines: entry.firstLines ?? "" });
    for (const red of step.reds) {
      const record = { step: id, id: red.id, firstLines: red.firstLines, durationMs: red.durationMs ?? null };
      if (Object.hasOwn(known, red.id)) {
        stillRed.push(record);
        const now = baselineReason(red.firstLines, context.repoRoot);
        if (known[red.id] !== now) {
          reasonChanged.push({ ...record, was: known[red.id], now });
          if (context.strictReasons) problems.push({ step: id, id: red.id, message: `known red changed its failure (--strict-reasons): ${known[red.id]} -> ${now}` });
        }
      } else {
        newReds.push(record);
      }
      kept[red.id] = baselineReason(red.firstLines, context.repoRoot);
    }
    for (const [entry, reason] of Object.entries(known)) {
      if (redIds.has(entry)) continue;
      // A known red that only passed on a retry is not fixed: it is flaky, and stays in the baseline.
      if (flakyIds.has(entry) && passedIds.has(entry)) { flakyKnown.push({ step: id, id: entry }); kept[entry] = reason; }
      else if (passedIds.has(entry) || passedPrefixes.some((prefix) => entry.startsWith(prefix))) fixed.push({ step: id, id: entry });
      else if (skippedIds.has(entry)) { skippedKnown.push({ step: id, id: entry }); kept[entry] = reason; }
      else if (inScope(step.scope, entry)) stale.push({ step: id, id: entry });
      else { notChecked.push({ step: id, id: entry }); kept[entry] = reason; }
    }
    for (const problem of step.problems) problems.push({ step: id, ...problem });
    if (Object.keys(kept).length > 0) nextReds[id] = sortedObject(Object.entries(kept));
    nextCalibration[id] = {
      commit: context.commit ?? null,
      date: context.date ?? null,
      scope: describeScope(step.scope),
      complete: scopeIsComplete(step.scope),
    };
  }
  const verdict = newReds.length === 0 && problems.length === 0 ? "pass" : "fail";
  return {
    verdict,
    exitCode: verdict === "pass" ? 0 : 1,
    newReds,
    stillRed,
    reasonChanged,
    flaky,
    flakyKnown,
    fixed,
    stale,
    skippedKnown,
    notChecked,
    problems,
    nextBaseline: { schema: BASELINE_SCHEMA, reds: sortedObject(Object.entries(nextReds)), calibration: sortedObject(Object.entries(nextCalibration)) },
  };
}

/** One line, repo root elided, for the baseline's human-readable reason. */
export function baselineReason(text, repoRoot) {
  let line = String(text ?? "").split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  if (repoRoot) line = line.split(repoRoot).join("<repo>");
  line = line.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** A test id with the checkout's absolute path made portable. Test titles can
 * embed absolute paths (a corpus path in a title), and an id that names one
 * checkout never matches the baseline on another, so every file-lane id goes
 * through this with the repository root. */
export function portableId(text, repoRoot) {
  return repoRoot ? String(text).split(repoRoot).join("<repo>") : String(text);
}

export function describeScope(scope) {
  switch (scope.kind) {
    case "none": return "nothing ran";
    case "all": return "everything";
    case "corpus": {
      const all = scope.completedShards.length === scope.shardCount && scope.ranShards.length === scope.shardCount;
      return all
        ? `all ${scope.shardCount} shards`
        : `shards ${scope.completedShards.join(",") || "(none)"} of ${scope.shardCount}` +
          (scope.ranShards.length > scope.completedShards.length ? ` (ran ${scope.ranShards.join(",")})` : "");
    }
    case "files": return `${scope.completedFiles.length} of ${scope.files.length} files`;
    case "cargo": return [scope.testRan ? "cargo test" : null, scope.clippyRan ? "cargo clippy" : null].filter(Boolean).join(" + ") || "nothing ran";
    default: return scope.kind;
  }
}

export function scopeIsComplete(scope) {
  switch (scope.kind) {
    case "all": return true;
    case "corpus": return scope.completedShards.length === scope.shardCount;
    case "files": return scope.completedFiles.length === scope.files.length;
    case "cargo": return scope.testRan && scope.clippyRan && scope.testResultsParsed && (scope.clippyResultsParsed ?? true);
    default: return false;
  }
}

// ---- summary ----------------------------------------------------------------

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "n/a";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function renderSummary(report) {
  const { verdict } = report;
  const lines = [];
  const counts = `${verdict.newReds.length} new red${verdict.newReds.length === 1 ? "" : "s"}, ${verdict.problems.length} problem${verdict.problems.length === 1 ? "" : "s"}`;
  lines.push(`gate:rust ${verdict.verdict.toUpperCase()} (${counts}) — mode ${report.mode}, ${formatDuration(report.durationMs)}, commit ${report.repo.commit?.slice(0, 8) ?? "?"}${report.repo.dirty ? " (dirty)" : ""}, ${report.finishedAt}`);
  for (const warning of report.options?.warnings ?? []) lines.push(`warning: ${warning}`);
  for (const step of report.steps) {
    const failing = verdict.newReds.some((red) => red.step === step.id) || verdict.problems.some((problem) => problem.step === step.id);
    const status = !step.ran ? "skip" : failing ? "FAIL" : step.reds.length > 0 ? "known" : "pass";
    lines.push(`${step.id.padEnd(14)} ${status.padEnd(5)} ${formatDuration(step.durationMs).padStart(7)}  ${step.ran ? step.headline : step.skippedReason ?? "not selected"}`);
  }
  const b = report.baseline;
  lines.push(`baseline ${b.path}: ${verdict.stillRed.length} known red${verdict.stillRed.length === 1 ? "" : "s"} still red (${verdict.reasonChanged.length} failing differently), ${verdict.fixed.length} fixed, ${verdict.stale.length} stale, ${verdict.skippedKnown.length} skipped, ${(verdict.flaky ?? []).length} flaky, ${verdict.notChecked.length} not checked in this run${b.updated ? " — baseline rewritten" : ""}`);
  const list = (title, entries, render) => {
    if (entries.length === 0) return;
    lines.push(`${title}:`);
    for (const entry of entries) lines.push(`  ${render(entry)}`);
  };
  list("NEW reds", verdict.newReds, (red) => `${red.step}::${red.id} — ${baselineReason(red.firstLines, report.repo.root)}`);
  list("problems", verdict.problems, (problem) => `${problem.step}: ${problem.message}`);
  list("fixed (remove from the baseline)", verdict.fixed, (entry) => `${entry.step}::${entry.id}`);
  list("stale (no such test any more; remove from the baseline)", verdict.stale, (entry) => `${entry.step}::${entry.id}`);
  list("known reds that now fail differently (check that the new failure is not a regression)", verdict.reasonChanged ?? [], (red) => `${red.step}::${red.id}\n      was: ${red.was}\n      now: ${red.now}`);
  list("flaky (passed only on a retry; a known red that does this stays in the baseline)", verdict.flaky ?? [], (entry) => `${entry.step}::${entry.id}${verdict.flakyKnown?.some((known) => known.step === entry.step && known.id === entry.id) ? " (known red)" : ""}`);
  list("known reds still red", verdict.stillRed, (red) => `${red.step}::${red.id}`);
  if (report.extrapolation) lines.push(`extrapolation: ${report.extrapolation.text}`);
  lines.push(`report: ${report.paths.report}`);
  return `${lines.join("\n")}\n`;
}
