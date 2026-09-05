#!/usr/bin/env node
// The island benchmark — the evidence behind "keep boa": three programs
// whose hot path is the embedded engine (Effect fibers, solid-js signal
// churn, the static/island JSON boundary) built with the Rust backend and
// timed against the same program under bun and Node. The programs need
// `effect` and `solid-js`, so they run from inside a project that installs
// them (the redcode workspace by default); results land in
// tests/dogfood/island-bench.json.
//
// Usage: node scripts/island-bench.mjs [--project <dir-with-node_modules>] [--write]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let project = path.resolve(repoRoot, "../redcode/packages/redcode");
let write = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project") project = path.resolve(args[++i]);
  else if (args[i] === "--write") write = true;
}
if (!existsSync(path.join(project, "node_modules"))) {
  console.error(`no node_modules under ${project}`);
  process.exit(1);
}
const bench = path.join(project, ".scriptc-bench");
rmSync(bench, { recursive: true, force: true });
mkdirSync(bench, { recursive: true });
cpSync(path.join(repoRoot, "tests/dogfood/island-bench"), bench, { recursive: true });
writeFileSync(path.join(bench, "package.json"), '{"name":"scriptc-island-bench","private":true,"type":"module"}\n');

const programs = ["effect-gen.ts", "solid-signals.ts", "json-exit.ts"];
const cli = path.join(repoRoot, "packages/cli/dist/bootstrap.js");
const which = (name) => { try { return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(); } catch { return null; } };
const bun = process.env["SCRIPTC_BUN"] ?? which("bun");
const timed = (cmd, argv, cwd) => {
  const t0 = performance.now();
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout: 600_000 });
  return { ms: Math.round(performance.now() - t0), code: r.status, stdout: (r.stdout ?? "").trim().split("\n").pop() ?? "", stderr: (r.stderr ?? "").trim().split("\n").slice(-2).join(" ") };
};
const results = {};
for (const program of programs) {
  const entry = path.join(bench, program);
  const out = path.join(bench, program.replace(/\.ts$/, ""));
  // Every program keeps a static entry and an island module (the frontier
  // shape); the compiler classifies it automatically.
  // solid-js's "node" export condition is its SSR build (signals and
  // effects are inert there); the "browser" condition is the universal
  // renderer every runtime resolves for this comparison.
  const build = timed(process.execPath, [cli, "build", entry, "--backend", "rust", "--dynamic", "--island-module", "auto", "--conditions", "browser", "-o", out], bench);
  const row = { build: { ms: build.ms, ok: build.code === 0, note: build.code === 0 ? "" : build.stderr } };
  if (build.code === 0) row.scriptc = timed(out, [], bench);
  row.node = timed(process.execPath, ["--conditions=browser", entry], bench);
  if (bun !== null) row.bun = timed(bun, ["run", "--conditions=browser", entry], bench);
  results[program] = row;
  console.log(program, JSON.stringify(row));
}
rmSync(bench, { recursive: true, force: true });
if (write) {
  const file = path.join(repoRoot, "tests/dogfood/island-bench.json");
  writeFileSync(file, JSON.stringify({ engine: "boa", project: path.relative(repoRoot, project), results }, null, 2) + "\n");
  console.log(`wrote ${path.relative(repoRoot, file)}`);
}
