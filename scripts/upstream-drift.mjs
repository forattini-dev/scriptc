#!/usr/bin/env node
// Reports how far this fork is from vercel-labs/scriptc and classifies every
// upstream-only commit since the fork point into the workstreams of the
// upstream adoption plan. It is an inventory tool: the classification is a
// heuristic over paths and subjects, not a support or compatibility claim.
//
// Offline by construction: it reads only local git refs and never fetches.
// A stale upstream ref means a stale report, so refresh with
// `git fetch upstream` before trusting the counts.
//
// Usage:
//   node scripts/upstream-drift.mjs            human report
//   node scripts/upstream-drift.mjs --json     machine-readable report

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const verbose = args.includes("--verbose") || args.includes("-v");

const UPSTREAM = process.env.SCRIPTC_UPSTREAM_REF || "upstream/main";

function git(...a) {
  return execFileSync("git", a, { encoding: "utf8" }).trim();
}

function tryGit(...a) {
  try {
    return git(...a);
  } catch {
    return null;
  }
}

if (tryGit("rev-parse", "--verify", UPSTREAM) === null) {
  console.error(`upstream ref '${UPSTREAM}' is not present locally.`);
  console.error(
    "Add it with: git remote add upstream git@github.com:vercel-labs/scriptc.git && git fetch upstream",
  );
  process.exit(2);
}

const head = git("rev-parse", "HEAD");
const base = git("merge-base", UPSTREAM, "HEAD");
const [upstreamOnly, forkOnly] = git(
  "rev-list",
  "--left-right",
  "--count",
  `${UPSTREAM}...HEAD`,
)
  .split(/\s+/)
  .map(Number);

const baseSubject = git("log", "-1", "--format=%h %ad %s", "--date=short", base);
const upstreamTip = git("log", "-1", "--format=%h %ad %s", "--date=short", UPSTREAM);

const newTags = [];
for (const tag of git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean)) {
  const inUpstream = tryGit("merge-base", "--is-ancestor", tag, UPSTREAM) !== null;
  const inFork = tryGit("merge-base", "--is-ancestor", tag, "HEAD") !== null;
  if (inUpstream && !inFork) newTags.push(tag);
}

const AREA_RULES = [
  [/^packages\/compiler\/src\/frontend\//, "frontend"],
  [/^packages\/compiler\/src\/backend\/rust\//, "backend-rust"],
  [/^packages\/compiler\/src\/backend\/llvm\//, "backend-llvm"],
  [/^packages\/compiler\/src\/backend\//, "backend-c"],
  [/^packages\/compiler\//, "compiler-other"],
  [/^packages\/runtime-rust\//, "runtime-rust"],
  [/^packages\/runtime\//, "runtime-c"],
  [/^(native|packages\/native)\//, "native"],
  [/^packages\/cli\//, "cli"],
  [/^tests\//, "tests"],
  [/^\.github\//, "ci"],
  [/^docs\//, "docs"],
  [/^(package\.json|pnpm-|Dockerfile|RELEASING|scripts\/)/, "packaging"],
];

function areasOf(files) {
  const seen = new Set();
  for (const file of files) {
    const rule = AREA_RULES.find(([re]) => re.test(file));
    seen.add(rule ? rule[1] : "other");
  }
  return [...seen];
}

const SKIP_SHA = new Set(["5a484034", "2bd2e6f5", "875c20b1", "3d1286cd", "af3f357f", "ebeb0316"]);
const CI_RE = /\b(test262|shard|corpus|ci:|parity|workload|expectations)\b/i;
const PACKAGING_RE =
  /\b(strip|artifact|granularity|glibc|debug section|release|windows|win32|gui executable|timing shim|musl)\b/i;
const NODE_RE =
  /\b(http|https|fs|filesystem|child_process|child process|zlib|crypto|node:module|event ?emitter|dgram|tls|dns|readline|querystring|url|float64|realpath|readdir|lstat|dirent|serverresponse|stdin|ipc|execfile|math|process)\b/i;

function workstreamOf(sha, subject, areas) {
  if (SKIP_SHA.has(sha)) return "fora-de-escopo";
  if (areas.every((a) => ["tests", "ci", "docs"].includes(a))) return "validacao-ci";
  if (CI_RE.test(subject)) return "validacao-ci";
  if (areas.includes("cli") || areas.includes("packaging")) {
    if (PACKAGING_RE.test(subject) || areas.includes("packaging")) return "empacotamento";
  }
  if (PACKAGING_RE.test(subject)) return "empacotamento";
  if (NODE_RE.test(subject)) return "superficie-node";
  if (areas.includes("frontend")) return "linguagem";
  if (areas.includes("runtime-rust") || areas.includes("runtime-c") || areas.includes("native")) {
    return "superficie-node";
  }
  return "outro";
}

const WORKSTREAM_ORDER = [
  "linguagem",
  "superficie-node",
  "validacao-ci",
  "empacotamento",
  "fora-de-escopo",
  "outro",
];

const raw = git(
  "log",
  `${head}..${UPSTREAM}`,
  "--no-merges",
  "--pretty=format:@@%H\x1f%ad\x1f%s",
  "--date=short",
  "--name-only",
);
const commits = [];
let current = null;
for (const line of raw.split("\n")) {
  if (line.startsWith("@@")) {
    const [sha, date, subject] = line.slice(2).split("\x1f");
    current = { sha, short: sha.slice(0, 8), date, subject, files: [] };
    commits.push(current);
  } else if (line.trim() !== "" && current) {
    current.files.push(line);
  }
}
for (const commit of commits) {
  commit.areas = areasOf(commit.files);
  commit.workstream = workstreamOf(commit.short, commit.subject, commit.areas);
}

const byWorkstream = Object.fromEntries(WORKSTREAM_ORDER.map((w) => [w, []]));
for (const commit of commits) byWorkstream[commit.workstream].push(commit);

const areaCounts = {};
for (const commit of commits) {
  for (const area of commit.areas) areaCounts[area] = (areaCounts[area] ?? 0) + 1;
}

const report = {
  upstreamRef: UPSTREAM,
  head,
  base,
  baseSubject,
  upstreamTip,
  upstreamOnly,
  forkOnly,
  newTags,
  workstreams: Object.fromEntries(
    WORKSTREAM_ORDER.map((w) => [w, byWorkstream[w].length]),
  ),
  areas: Object.fromEntries(Object.entries(areaCounts).sort((a, b) => b[1] - a[1])),
  commits: commits.map((c) => ({
    sha: c.short,
    date: c.date,
    workstream: c.workstream,
    areas: c.areas,
    subject: c.subject,
  })),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("scriptc upstream drift (offline; refresh with `git fetch upstream`)");
  console.log(`  fork point:  ${baseSubject}`);
  console.log(`  fork HEAD:   ${head.slice(0, 8)}`);
  console.log(`  upstream:    ${upstreamTip}`);
  console.log(`  upstream-only commits: ${upstreamOnly}`);
  console.log(`  fork-only commits:     ${forkOnly}`);
  console.log(
    `  new upstream tags:     ${newTags.length ? newTags.join(" ") : "(none)"}`,
  );
  console.log("");
  console.log("workstreams (from the adoption plan):");
  for (const name of WORKSTREAM_ORDER) {
    console.log(`  ${name.padEnd(16)} ${byWorkstream[name].length}`);
  }
  console.log("");
  console.log("paths:");
  for (const [area, count] of Object.entries(report.areas)) {
    console.log(`  ${area.padEnd(16)} ${count}`);
  }
  if (verbose) {
    console.log("");
    for (const name of WORKSTREAM_ORDER) {
      if (byWorkstream[name].length === 0) continue;
      console.log(`${name}:`);
      for (const c of byWorkstream[name]) {
        console.log(`  ${c.short} ${c.date} ${c.subject}`);
      }
    }
  } else {
    console.log("");
    console.log("run with --verbose for the per-commit listing");
  }
}
