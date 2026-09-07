#!/usr/bin/env node
// The dogfood scoreboard: one objective number per session for a real
// target program (the redcode monorepo is the first). It runs the
// compiler's analysis (`scriptc coverage`, in process) over an entry,
// folds every diagnostic into a construct FAMILY (not just a code — the
// same SC1090 means "computed extends" in one place and "JSX" in
// another), attributes each to the workspace package it lives in, and
// records the lowering phase timings. The result is compared with the
// committed scoreboard and, with --write, replaces it.
//
// Usage:
//   node scripts/dogfood-scoreboard.mjs <entry.ts> [--dynamic] [--target <id>]
//        [--npm-static <pkg>]... [--island-module <glob>]... [--name redcode] [--write]
//
// The committed file is tests/dogfood/<name>.scoreboard.json. Nothing
// here is a test gate: the scoreboard is the progress meter the plan's
// milestones report against, so every session ends with a delta.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
  console.error("usage: node scripts/dogfood-scoreboard.mjs <entry.ts> [--dynamic] [--npm-static <pkg>]... [--name <name>] [--write]");
  process.exit(args.length === 0 ? 1 : 0);
}
let entry = null;
let dynamic = false;
let write = false;
let name = "redcode";
let target;
let backend;
let allowEngine = true;
let writeTiers = false;
const npmStatic = [];
const islandModules = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dynamic") dynamic = true;
  else if (a === "--write") write = true;
  else if (a === "--npm-static") npmStatic.push(args[++i]);
  else if (a === "--name") name = args[++i];
  else if (a === "--target") target = args[++i];
  else if (a === "--backend") backend = args[++i];
  else if (a === "--no-engine") allowEngine = false;
  else if (a === "--write-tiers") writeTiers = true;
  else if (a === "--island-module") islandModules.push(args[++i]);
  else if (a.startsWith("--")) { console.error(`unknown flag ${a}`); process.exit(1); }
  else entry = path.resolve(a);
}
if (entry === null || !existsSync(entry)) { console.error("entry file missing"); process.exit(1); }
if (backend !== undefined && !["rust", "c", "llvm"].includes(backend)) {
  console.error("backend must be rust, c or llvm"); process.exit(1);
}

const { analyze, writeProjectTiers } = await import(path.join(repoRoot, "packages/compiler/dist/index.js"));

// Lowering phase timings arrive on stderr as `scriptc lowering {...}`
// JSON lines when SCRIPTC_TIMING=1; capture them without losing the rest.
process.env["SCRIPTC_TIMING"] = "1";
const timing = {};
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const text = String(chunk);
  let captured = false;
  for (const line of text.split("\n")) {
    const m = /^scriptc (lowering|timing) (\{.*\})$/.exec(line);
    if (!m) continue;
    captured = true;
    try {
      const row = JSON.parse(m[2]);
      if (typeof row.phase === "string") timing[row.phase] = Math.round(row.phase_ms ?? 0);
    } catch { /* not ours */ }
  }
  return captured ? true : realWrite(chunk, ...rest);
};

const t0 = performance.now();
const { coverage } = analyze(entry, {
  dynamic,
  allowEngine,
  ...(backend === undefined ? {} : { backend }),
  ...(target !== undefined ? { target } : {}),
  ...(npmStatic.length > 0 ? { npmStatic } : {}),
  ...(islandModules.length > 0 ? { islandModules } : {}),
});
const wallMs = Math.round(performance.now() - t0);
process.stderr.write = realWrite;
if (writeTiers && !coverage.preflightFailed) console.log(`tiers: wrote ${writeProjectTiers()}`);

/** The construct family a diagnostic belongs to — the unit the plan's
 * workstreams are cut along. Order matters: first match wins. */
function familyOf(d) {
  const m = d.message;
  switch (d.code) {
    case "SC1090":
      if (/extending computed expressions/.test(m)) return "computed-extends";
      if (/crossing into dynamically-executed code/.test(m)) return "island-boundary-function";
      if (/JSX/.test(m)) return "jsx";
      if (/generic method|method calls like/.test(m)) return "generic-dispatch";
      if (/namespace/.test(m)) return "namespace-object-value";
      if (/optional\/defaulted parameters|assignment to non-variables|object spread after|type predicates/.test(m)) return "solid-idioms";
      if (/property-access metaprogramming/.test(m)) return "metaprogramming";
      return "syntax-other";
    case "SC2009":
      if (/Generator/.test(m)) return "effect-generator-body";
      if (/Brand</.test(m)) return "branded-intersection";
      if (/Effect</.test(m)) return "effect-typed-member";
      return "component-other";
    case "SC2004": return "cascade";
    case "SC1013": return "namespace-object-value";
    case "SC2020": return "stdlib-tail";
    case "SC2001": return "type-residual";
    case "SC2008": return "intersection-shape";
    case "SC2006": return "index-signature";
    case "SC2030": return "island-cannot-embed";
    case "SC3001": return "rust-backend-refusal";
    default: return d.code;
  }
}

/** The stdlib member a SC2020 names, so the tail is a ranked list. */
function memberOf(d) {
  const m = /^'([^']+)'/.exec(d.message);
  return m ? m[1] : null;
}

const entryRoot = (() => {
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (path.basename(path.dirname(dir)) === "packages") return path.dirname(path.dirname(dir));
    dir = path.dirname(dir);
  }
  return path.dirname(entry);
})();
function packageOf(file) {
  const rel = path.relative(entryRoot, file);
  const m = /^packages\/([^/]+)\//.exec(rel);
  if (m) return m[1];
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
  return nm ? `npm:${nm[1]}` : "(other)";
}

function fold(diagnostics) {
  const byCode = {};
  const byFamily = {};
  const byPackage = {};
  const families = new Map();
  const stdlibTail = {};
  for (const d of diagnostics) {
    const fam = familyOf(d);
    const pkg = packageOf(d.loc.file);
    byCode[d.code] = (byCode[d.code] ?? 0) + 1;
    byFamily[fam] = (byFamily[fam] ?? 0) + 1;
    byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
    let row = families.get(fam);
    if (!row) { row = { family: fam, count: 0, codes: {}, packages: {}, sample: null }; families.set(fam, row); }
    row.count++;
    row.codes[d.code] = (row.codes[d.code] ?? 0) + 1;
    row.packages[pkg] = (row.packages[pkg] ?? 0) + 1;
    if (row.sample === null) row.sample = { file: path.relative(entryRoot, d.loc.file), message: d.message.slice(0, 200) };
    if (d.code === "SC2020") { const mem = memberOf(d); if (mem) stdlibTail[mem] = (stdlibTail[mem] ?? 0) + 1; }
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return {
    total: diagnostics.length,
    byCode: sorted(byCode),
    byFamily: sorted(byFamily),
    byPackage: sorted(byPackage),
    families: [...families.values()].sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
      .map((r) => ({ ...r, codes: sorted(r.codes), packages: sorted(r.packages) })),
    stdlibTail: sorted(stdlibTail),
  };
}

const board = {
  name,
  entry: path.relative(repoRoot, entry),
  options: { dynamic, target: target ?? null, backend: backend ?? null, allowEngine, npmStatic, islandModules },
  validation: backend !== undefined || !allowEngine ? "backend-emission" : "frontend-only",
  execution: coverage.execution ?? null,
  preflightFailed: coverage.preflightFailed,
  stats: coverage.stats,
  unreachedStats: coverage.unreached?.stats ?? null,
  reached: fold(coverage.diagnostics),
  unreached: coverage.unreached ? fold(coverage.unreached.diagnostics) : null,
  runtimeFences: coverage.runtimeFences?.length ?? 0,
  npmStatic: coverage.npmStatic ?? [],
  npmBuiltins: (coverage.npmBuiltins ?? []).map((b) => b.specifier ?? b.name ?? String(b)).sort(),
  frontier: coverage.tiers ?? null,
  timing: { wallMs, phases: timing },
};

const outPath = path.join(repoRoot, "tests/dogfood", `${name}.scoreboard.json`);
const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;

const delta = (label, before, after) => {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const rows = [...keys].map((k) => [k, before?.[k] ?? 0, after?.[k] ?? 0]).filter(([, b, a]) => b !== a)
    .sort((x, y) => (y[2] - y[1]) - (x[2] - x[1]));
  if (rows.length === 0) { console.log(`${label}: no change`); return; }
  console.log(`${label}:`);
  for (const [k, b, a] of rows) console.log(`  ${String(a - b > 0 ? "+" + (a - b) : a - b).padStart(6)}  ${k}  (${b} → ${a})`);
};
console.log(`${name}: ${board.reached.total} reached diagnostics, ${board.unreached?.total ?? 0} unreached; ` +
  `statements ${board.stats.statementsTotal} total / ${board.stats.statementsFailed} failed / ${board.stats.statementsIsland} island; ` +
  `${wallMs} ms (${Object.entries(timing).map(([k, v]) => `${k} ${v}ms`).join(", ") || "no phase timing"})`);
if (previous) {
  console.log(`vs committed: ${previous.reached.total} → ${board.reached.total} reached`);
  delta("by family", previous.reached.byFamily, board.reached.byFamily);
  delta("by package", previous.reached.byPackage, board.reached.byPackage);
} else {
  console.log("no committed scoreboard yet");
  console.log("by family:", board.reached.byFamily);
  console.log("by package:", board.reached.byPackage);
}
if (write) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(board, null, 2) + "\n");
  console.log(`wrote ${path.relative(repoRoot, outPath)}`);
}
