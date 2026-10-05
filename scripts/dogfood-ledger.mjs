#!/usr/bin/env node
// The dogfood distance ledger: for every entry of a mission file it runs
// the compiler's analysis (analyze(), in a child process per entry) under
// the mission's options and reports where a no-engine build stops and how
// far it is — blockers = lowering diagnostics + reached runtime fences —
// with the fences broken down by code, package, family and site, the
// unreached remainder, npm admission, and the consumer's identity.
//
// Usage:
//   pnpm dogfood:ledger                    # table across entries + deltas vs tests/dogfood/ledger/<name>.json
//   pnpm dogfood:ledger -- --entry <name>  # one entry (repeatable)
//   pnpm dogfood:ledger -- --write         # store the compact records as the committed baseline
//   pnpm dogfood:ledger -- --json          # the records as JSON instead of the table
//   pnpm dogfood:ledger -- --mission <file> --timeout-ms <n> --top <families>
//   pnpm dogfood:ledger -- --replay        # re-summarise the previous run's raw results instead of analyzing again
//
// The mission file (tests/dogfood/mission.json) names the entries and the
// root placeholders; every root resolves from an environment variable with
// a default, so a missing consumer makes its entry "unavailable" instead of
// failing the run. Run it from source with tsx (the compiler's .js import
// specifiers resolve only under the loader); `pnpm dogfood:ledger` does.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { renderLedger, summarizeEntry } from "./lib/dogfood-ledger-summary.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

if (process.argv[2] === "--worker") {
  await runWorker(process.argv[3]);
} else {
  await runDriver(process.argv.slice(2));
}

/* ── the worker: one analysis, one JSON result file ───────────────────── */

async function runWorker(payloadPath) {
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  const result = { node: process.version, ok: false };
  const t0 = performance.now();
  try {
    const { analyze } = await import(path.join(repoRoot, "packages/compiler/src/index.ts"));
    const analysis = analyze(payload.entry, payload.options);
    const { statsByFile, provenance, ...coverage } = analysis.coverage;
    result.ok = true;
    result.coverage = coverage;
    result.sources = analysis.sourceTexts.size;
    result.declarationFiles = analysis.declarationFiles ?? null;
  } catch (error) {
    result.error = {
      name: error?.name ?? "Error",
      message: String(error?.message ?? error),
      stackHead: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 4).join("\n") : undefined,
    };
  }
  result.elapsedMs = Math.round(performance.now() - t0);
  result.peakRssKiB = process.resourceUsage().maxRSS;
  writeFileSync(payload.out, JSON.stringify(result));
}

/* ── the driver ───────────────────────────────────────────────────────── */

async function runDriver(args) {
  const opts = parseArgs(args);
  const mission = JSON.parse(readFileSync(opts.mission, "utf8"));
  const roots = resolveRoots(mission.roots ?? {});
  const relativize = makeRelativizer(roots);
  const ledgerDir = path.join(repoRoot, "tests/dogfood/ledger");
  const compiler = compilerIdentity();
  const selected = (mission.entries ?? []).filter((e) => opts.entries.length === 0 || opts.entries.includes(e.name));
  if (selected.length === 0) {
    console.error(`no entries selected (mission has: ${(mission.entries ?? []).map((e) => e.name).join(", ")})`);
    process.exit(1);
  }
  if (!opts.json) {
    console.error(`dogfood ledger: ${selected.length} entr${selected.length === 1 ? "y" : "ies"}; roots ${Object.entries(roots).map(([k, r]) => `${k}=${r.path}${r.source === "default" ? "" : ` (${r.source})`}`).join(", ")}`);
  }
  const records = [];
  const committed = new Map();
  for (const entry of selected) {
    const committedPath = path.join(ledgerDir, `${entry.name}.json`);
    if (existsSync(committedPath)) committed.set(entry.name, JSON.parse(readFileSync(committedPath, "utf8")));
    const record = await runEntry(entry, { mission, roots, relativize, compiler, opts });
    records.push(record);
    if (!opts.json) console.error(`  ${entry.name}: ${record.stage}${record.elapsedMs !== undefined ? ` (${record.elapsedMs} ms)` : ""}`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
  } else {
    process.stdout.write(renderLedger(records, committed) + "\n");
  }
  if (opts.write) {
    mkdirSync(ledgerDir, { recursive: true });
    for (const record of records) {
      const target = path.join(ledgerDir, `${record.name}.json`);
      if ((record.stage === "unavailable" || record.stage === "crashed") && existsSync(target)) {
        console.error(`not overwriting ${path.relative(repoRoot, target)}: this run's record is '${record.stage}'`);
        continue;
      }
      writeFileSync(target, JSON.stringify(record, null, 2) + "\n");
      console.error(`wrote ${path.relative(repoRoot, target)}`);
    }
  }
}

function parseArgs(args) {
  const opts = { entries: [], write: false, json: false, replay: false, mission: path.join(repoRoot, "tests/dogfood/mission.json"), timeoutMs: 30 * 60 * 1000, top: 25 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--replay") opts.replay = true;
    else if (a === "--entry") opts.entries.push(args[++i]);
    else if (a === "--mission") opts.mission = path.resolve(args[++i]);
    else if (a === "--timeout-ms") opts.timeoutMs = Number(args[++i]);
    else if (a === "--top") opts.top = Number(args[++i]);
    else if (a === "--help") { console.error(usage()); process.exit(0); }
    else { console.error(`unknown argument ${a}\n${usage()}`); process.exit(1); }
  }
  return opts;
}

function usage() {
  return "usage: pnpm dogfood:ledger -- [--entry <name>]... [--write] [--json] [--replay] [--mission <file>] [--timeout-ms <n>] [--top <n>]";
}

/** Resolves the mission's root placeholders: an environment override,
 * else the default (which may reference earlier roots). `repo` is this
 * checkout; `main` defaults to the git common directory's parent, so a
 * worktree finds the consumers beside the main checkout. */
function resolveRoots(spec) {
  const roots = { repo: { path: repoRoot, source: "builtin" } };
  const mainDefault = gitMainCheckout();
  const expand = (text) => text.replace(/\$\{([^}]+)\}/g, (m, name) => {
    if (roots[name] === undefined) throw new Error(`root '${name}' used before it was defined (${m})`);
    return roots[name].path;
  });
  for (const [name, root] of Object.entries(spec)) {
    if (name === "repo") continue;
    const env = root.env !== undefined ? process.env[root.env] : undefined;
    if (env !== undefined && env !== "") {
      roots[name] = { path: path.resolve(env), source: `env ${root.env}` };
    } else if (name === "main" && root.default === undefined) {
      roots[name] = { path: mainDefault, source: "default" };
    } else {
      roots[name] = { path: path.resolve(expand(root.default ?? "")), source: "default" };
    }
  }
  if (roots.main === undefined) roots.main = { path: mainDefault, source: "default" };
  return roots;
}

function gitMainCheckout() {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return path.dirname(common);
  } catch {
    return repoRoot;
  }
}

function expandPlaceholders(text, roots) {
  return text.replace(/\$\{([^}]+)\}/g, (m, name) => {
    if (roots[name] === undefined) throw new Error(`unknown root ${m}`);
    return roots[name].path;
  });
}

/** Maps absolute paths back onto `${root}` placeholders (longest root
 * first) and the home directory onto `~`, so records never carry a
 * machine-specific path. */
function makeRelativizer(roots) {
  const ordered = Object.entries(roots).sort((a, b) => b[1].path.length - a[1].path.length);
  const home = homedir();
  return (text) => {
    if (typeof text !== "string") return text;
    let out = text;
    for (const [name, root] of ordered) {
      out = out.split(root.path + "/").join(`\${${name}}/`);
      out = out.split(root.path).join(`\${${name}}`);
    }
    if (home) out = out.split(home + "/").join("~/").split(home).join("~");
    return out;
  };
}

/** The compiler the run used: this checkout's HEAD and how many TRACKED
 * paths differ from it (untracked files never change what compiled). */
function compilerIdentity() {
  return {
    head: gitOutput(repoRoot, ["rev-parse", "HEAD"]),
    branch: gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirtyPaths: gitLines(repoRoot, ["status", "--porcelain", "--untracked-files=no"]),
  };
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function gitLines(cwd, args) {
  const out = gitOutput(cwd, args);
  return out === null ? null : out === "" ? 0 : out.split("\n").length;
}

function sha256File(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** The consumer's identity for the record: a git repository (HEAD and the
 * dirty path count, untracked files included — a consumer's untracked
 * source can be imported), or an npm fixture directory (lockfile hash and
 * installed versions), plus the @types/node roots the checker program
 * loaded. */
function consumerIdentity(spec, roots, relativize, declarationFiles) {
  if (!spec) return null;
  const identity = { kind: spec.kind };
  if (spec.kind === "git") {
    const root = expandPlaceholders(spec.root, roots);
    identity.root = relativize(root);
    identity.head = gitOutput(root, ["rev-parse", "HEAD"]);
    identity.branch = gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    identity.dirtyPaths = gitLines(root, ["status", "--porcelain"]);
    if (spec.dirtyTree === true) identity.dirtyTree = true;
  } else if (spec.kind === "npm") {
    const dir = expandPlaceholders(spec.dir, roots);
    identity.dir = relativize(dir);
    identity.lockfileSha256 = sha256File(path.join(dir, "package-lock.json"));
    identity.installed = {};
    for (const name of spec.packages ?? []) {
      try {
        identity.installed[name] = JSON.parse(readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")).version ?? null;
      } catch {
        identity.installed[name] = null;
      }
    }
  }
  if (Array.isArray(declarationFiles)) identity.typesNode = typesNodeRoots(declarationFiles, relativize);
  return identity;
}

/** Every distinct @types/node package the program's declaration files come
 * from, with its version: two majors in one program is the mixed-types
 * hypothesis made visible. */
function typesNodeRoots(declarationFiles, relativize) {
  const byRoot = new Map();
  for (const file of declarationFiles) {
    const normalized = file.replace(/\\/g, "/");
    const marker = "/node_modules/@types/node/";
    const at = normalized.lastIndexOf(marker);
    if (at === -1) continue;
    const root = normalized.slice(0, at + marker.length - 1);
    byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
  }
  const rows = [];
  for (const [root, files] of byRoot) {
    let version = null;
    try {
      version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version ?? null;
    } catch { /* unreadable root: version unknown */ }
    rows.push({ version, root: relativize(root), files });
  }
  rows.sort((a, b) => b.files - a.files || String(a.version).localeCompare(String(b.version)));
  return { distinctVersions: [...new Set(rows.map((r) => r.version))], roots: rows };
}

async function runEntry(entry, { mission, roots, relativize, compiler, opts }) {
  const options = { ...(mission.options ?? {}), ...(entry.options ?? {}) };
  const generatedAt = new Date().toISOString();
  const common = { name: entry.name, options, compiler, generatedAt, relativize, topFamilies: opts.top, ...(entry.note ? { note: entry.note } : {}) };
  let entryPath;
  try {
    entryPath = expandPlaceholders(entry.entry, roots);
  } catch (error) {
    return withNote(summarizeEntry({ ...common, entry: entry.entry, unavailable: error.message }), entry);
  }
  const missing = [entryPath, ...(entry.requires ?? []).map((r) => expandPlaceholders(r, roots))].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return withNote(summarizeEntry({
      ...common,
      entry: entryPath,
      consumer: consumerIdentity(entry.consumer, roots, relativize, null),
      unavailable: `missing on this machine: ${missing.join(", ")}`,
    }), entry);
  }
  const result = opts.replay ? replayResult(entry.name) : await analyzeInChild(entry.name, entryPath, options, opts.timeoutMs);
  const consumer = consumerIdentity(entry.consumer, roots, relativize, result.declarationFiles ?? null);
  const entrySha256 = sha256File(entryPath);
  if (!result.ok) {
    return withNote(summarizeEntry({ ...common, entry: entryPath, consumer, node: result.node, crashed: result.error, analysis: { elapsedMs: result.elapsedMs } }), entry, entrySha256);
  }
  return withNote(summarizeEntry({
    ...common,
    entry: entryPath,
    consumer,
    node: result.node,
    analysis: { coverage: result.coverage, sources: result.sources, elapsedMs: result.elapsedMs, peakRssKiB: result.peakRssKiB },
  }), entry, entrySha256);
}

function withNote(record, entry, entrySha256 = null) {
  const out = { ...record };
  if (entrySha256) out.entrySha256 = entrySha256;
  if (entry.note) out.note = entry.note;
  return out;
}

/** One analysis per child process: the compiler's analysis holds process-
 * global state and the heavy entries take ~0.75 GB, so each entry gets a
 * fresh process (run through tsx: the compiler loads from source). */
function resultsDir() {
  const dir = path.join(process.env["MISSION_SCRATCH"] ?? process.env["TMPDIR"] ?? path.join(repoRoot, "node_modules/.cache"), "dogfood-ledger");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** --replay: the raw result the previous run kept for this entry (so the
 * summary can be regenerated without the analysis). */
function replayResult(name) {
  const file = path.join(resultsDir(), `latest-${name}.json`);
  if (!existsSync(file)) return { ok: false, node: process.version, error: { name: "NoReplay", message: `no kept result for ${name} at ${file}` } };
  return JSON.parse(readFileSync(file, "utf8"));
}

function analyzeInChild(name, entry, options, timeoutMs) {
  const scratch = resultsDir();
  const stamp = `${process.pid}-${Date.now()}`;
  const payloadPath = path.join(scratch, `payload-${stamp}.json`);
  const outPath = path.join(scratch, `result-${stamp}.json`);
  writeFileSync(payloadPath, JSON.stringify({ entry, options, out: outPath }));
  // The worker runs under the SAME Node binary as the driver (Node 24 and
  // Node 26 are both first-class hosts), through tsx's CLI so the compiler
  // loads from source.
  const tsxCli = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [tsxCli, scriptPath, "--worker", payloadPath], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (existsSync(outPath)) {
        try {
          const result = JSON.parse(readFileSync(outPath, "utf8"));
          writeFileSync(path.join(scratch, `latest-${name}.json`), JSON.stringify(result));
          resolveResult(result);
          return;
        } catch (error) {
          resolveResult({ ok: false, error: { name: "LedgerError", message: `unreadable worker result: ${error.message}` } });
          return;
        }
      }
      resolveResult({
        ok: false,
        node: process.version,
        error: {
          name: timedOut ? "Timeout" : "WorkerExit",
          message: timedOut ? `analysis exceeded ${timeoutMs} ms` : `worker exited with ${signal ?? `code ${code}`} before writing a result`,
        },
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ ok: false, node: process.version, error: { name: error.name, message: error.message } });
    });
  });
}
