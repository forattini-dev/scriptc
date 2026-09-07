#!/usr/bin/env node
// Repeated Linux process benchmarks with an output-equivalence gate.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, release } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  spec: { type: "string" }, out: { type: "string" },
  runs: { type: "string", default: "7" }, warmup: { type: "string", default: "2" },
} });
if (!values.spec || !values.out || process.platform !== "linux") {
  throw new Error("usage (Linux, GNU time): node scripts/native-benchmark.mjs --spec cases.json --out results-directory [--runs 7] [--warmup 2]");
}
const runs = Number(values.runs);
const warmup = Number(values.warmup);
if (!Number.isInteger(runs) || runs < 2 || !Number.isInteger(warmup) || warmup < 0) {
  throw new Error("runs must be an integer >= 2; warmup must be an integer >= 0");
}
const specPath = resolve(values.spec);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const out = resolve(values.out);
const fromSpec = (path) => resolve(dirname(specPath), path);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (path) => ({ path, sha256: hash(readFileSync(path)), bytes: statSync(path).size });
if (!Array.isArray(spec.cases) || spec.cases.length < 2) throw new Error("spec.cases must contain at least two candidates");
const names = new Set();
const cases = spec.cases.map((item) => {
  if (typeof item.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.name) || names.has(item.name)) throw new Error("case names must be unique filename-safe strings");
  names.add(item.name);
  if (!Array.isArray(item.command) || item.command.length === 0 || !item.command.every((s) => typeof s === "string") || !isAbsolute(item.command[0])) {
    throw new Error(`${item.name}: command must be an argv array beginning with an absolute executable path`);
  }
  const command = [...item.command];
  command[0] = realpathSync(command[0]);
  const executable = fingerprint(command[0]);
  const cwd = fromSpec(item.cwd ?? ".");
  const artifacts = (item.artifacts ?? []).map((p) => resolve(cwd, p));
  let acceptance = null;
  if (item.acceptance) {
    const path = fromSpec(item.acceptance);
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (!record.build?.ok || record.build.execution?.engine !== "none" || record.build.runtimeFences?.length !== 0 || record.build.binarySha256 !== executable.sha256) {
      throw new Error(`${item.name}: acceptance must certify this exact engine-free executable`);
    }
    acceptance = { ...fingerprint(path), compiler: record.compiler, consumer: record.consumer };
  }
  return { name: item.name, command, cwd, artifacts, executable, acceptance };
});
const inputs = (spec.inputs ?? []).map((p) => fingerprint(fromSpec(p)));
mkdirSync(out, { recursive: true });
const report = {
  schema: 1, createdAt: new Date().toISOString(), spec: fingerprint(specPath),
  host: { platform: process.platform, arch: process.arch, release: release(), cpus: cpus().length, cpu: cpus()[0]?.model, node: process.version },
  measurement: "fresh process per sample; warmup included in output checks; GNU time CPU seconds and peak RSS KiB; elapsed includes process launch; alternating candidate order",
  runs, warmup, inputs, cases, samples: [], equivalence: false, summary: null,
};
const save = () => writeFileSync(join(out, "benchmark.json"), JSON.stringify(report, null, 2) + "\n");
let expected = null;
try {
  const timeVersion = spawnSync("/usr/bin/time", ["--version"], { encoding: "utf8" });
  if (timeVersion.status !== 0 || !timeVersion.stdout.includes("GNU")) throw new Error("GNU /usr/bin/time is required");
  report.host.time = timeVersion.stdout.split("\n")[0];
  save();
  for (let round = -warmup; round < runs; round++) {
    const ordered = (round + warmup) % 2 === 0 ? cases : [...cases].reverse();
    for (const item of ordered) {
      const id = `${item.name}-${round < 0 ? `warmup-${round + warmup}` : round}`;
      const timingPath = join(out, `${id}.time`);
      // Artifacts must be refreshed by the command, so stale output cannot
      // satisfy equivalence after a failed or incomplete renderer run.
      const before = item.artifacts.map((path) => existsSync(path) ? statSync(path, { bigint: true }).mtimeNs : null);
      const started = performance.now();
      const result = spawnSync("/usr/bin/time", ["-f", "%U\n%S\n%M", "-o", timingPath, "--", ...item.command], {
        cwd: item.cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: process.env,
      });
      const elapsedMs = performance.now() - started;
      writeFileSync(join(out, `${id}.stdout`), result.stdout ?? "");
      writeFileSync(join(out, `${id}.stderr`), result.stderr ?? "");
      if (result.error || result.status !== 0) throw new Error(`${id}: command failed (${result.error?.message ?? result.signal ?? result.status})`);
      const [userSeconds, systemSeconds, peakRssKiB] = readFileSync(timingPath, "utf8").trim().split("\n").map(Number);
      if (![userSeconds, systemSeconds, peakRssKiB].every((v) => Number.isFinite(v) && v >= 0)) throw new Error(`${id}: invalid GNU time measurements`);
      const artifacts = item.artifacts.map((path, index) => {
        if (statSync(path, { bigint: true }).mtimeNs === before[index]) throw new Error(`${id}: artifact was not refreshed: ${path}`);
        return fingerprint(path);
      });
      const output = {
        stdout: hash(result.stdout), stderr: hash(result.stderr), exitCode: result.status,
        artifacts: artifacts.map(({ sha256, bytes }) => ({ sha256, bytes })),
      };
      const identity = JSON.stringify(output);
      if (expected === null) expected = identity;
      const matches = expected === identity;
      report.samples.push({ candidate: item.name, round, warmup: round < 0, elapsedMs, userSeconds, systemSeconds, cpuSeconds: userSeconds + systemSeconds, peakRssKiB, output, matches });
      save();
      if (!matches) throw new Error(`${id}: output differs from the first candidate; performance comparison refused`);
    }
  }
  for (const original of [report.spec, ...inputs, ...cases.map((item) => item.executable)]) {
    if (fingerprint(original.path).sha256 !== original.sha256) throw new Error(`input changed during benchmark: ${original.path}`);
  }
  const stats = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return { min: sorted[0], median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, max: sorted.at(-1) };
  };
  report.equivalence = true;
  report.summary = cases.map((item) => {
    const samples = report.samples.filter((s) => s.candidate === item.name && !s.warmup);
    return { candidate: item.name, executableBytes: item.executable.bytes, ...Object.fromEntries(["elapsedMs", "cpuSeconds", "peakRssKiB"].map((key) => [key, stats(samples.map((s) => s[key]))])) };
  });
  save();
  console.log(join(out, "benchmark.json"));
} catch (error) {
  report.error = error.message;
  save();
  console.error(error.message);
  process.exitCode = 1;
}
