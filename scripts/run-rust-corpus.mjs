#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readMatrix, writeMatrix } from "./rust-corpus-matrix.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`missing value for ${name}`);
  return args[index + 1];
}
for (let index = 0; index < args.length; index += 2)
  if (!["--out-dir", "--shards", "--pattern"].includes(args[index])) throw new Error(`unknown option: ${args[index]}`);
const shards = Number(option("--shards", "2"));
if (!Number.isInteger(shards) || shards < 1 || shards > 8) throw new Error("--shards must be 1 through 8");
const pattern = option("--pattern", "");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = path.resolve(option("--out-dir", path.join(repo, "node_modules/.cache/rust-corpus", stamp)));
fs.mkdirSync(output, { recursive: true });
if (fs.existsSync(path.join(output, "metadata.json"))) throw new Error("output directory already contains a run; choose a fresh directory");
const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tool = (exe, args) => { const result = spawnSync(exe, args, { encoding: "utf8", timeout: 30000, windowsHide: true }); return result.status === 0 ? result.stdout.trim() : undefined; };
const pin = (file, name) => new RegExp(`export const ${name} = "([^"]+)"`).exec(fs.readFileSync(path.join(repo, file), "utf8"))?.[1];
const node24 = pin("packages/compiler/src/compat/node-matrix.ts", "NODE24_VERSION");
const node26 = pin("packages/compiler/src/compat/node-matrix.ts", "NODE26_VERSION");
const bun = pin("packages/compiler/src/compat/runtime-target.ts", "BUN_VERSION");
const oracle = process.env.SCRIPTC_NODE_ORACLE ?? tool("mise", ["which", "node", "--tool", `node@${node24}`]);
const node26Oracle = process.env.SCRIPTC_NODE_NODE26 ?? tool("mise", ["which", "node", "--tool", `node@${node26}`]);
const bunOracle = process.env.SCRIPTC_BUN ?? tool("mise", ["which", "bun", "--tool", `bun@${bun}`]);
const windowsPython = process.platform === "win32" ? process.env.SCRIPTC_RUST_WINDOWS_JOB_PYTHON ?? tool("mise", ["which", "python"]) : undefined;
if (process.platform === "win32" && !windowsPython) throw new Error("Windows corpus execution requires Python 3 for bounded process jobs; set SCRIPTC_RUST_WINDOWS_JOB_PYTHON");
const rustBuildDefaults = { CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0", CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? "0" };
const rustPin = /channel\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(repo, "packages/runtime-rust/rust-toolchain.toml"), "utf8"))?.[1];
const rustup = path.join(homedir(), ".cargo", "bin", process.platform === "win32" ? "rustup.exe" : "rustup");
const rustc = rustPin ? tool(fs.existsSync(rustup) ? rustup : "rustup", ["which", "--toolchain", rustPin, "rustc"]) : undefined;
const driverSource = fs.readFileSync(path.join(repo, "tests/harness/driver-fixtures.ts"), "utf8");
const drivers = new Set([...driverSource.matchAll(/"([0-9][^"\n]+\.(?:ts|js|mjs|cjs))"/g)].map(match => match[1]));
const inventory = ["ts", "js", "mjs", "cjs"].flatMap(ext => [...fs.globSync([`tests/corpus/*.${ext}`, `tests/corpus/*/main.${ext}`], { cwd: repo })])
  .map(file => file.slice("tests/corpus/".length).replaceAll("\\", "/"))
  .filter(file => !drivers.has(file) && (!pattern || new RegExp(pattern).test(file))).sort();
if (!inventory.length) throw new Error("no corpus programs selected");
fs.writeFileSync(path.join(output, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
const sourceHashes = {};
console.log(`Capturing source hashes for ${inventory.length} selected programs`);
for (const file of [...git(["ls-files"]).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n")].filter(file => /^(packages|tests|scripts)\//.test(file))) {
  const full = path.join(repo, file);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) sourceHashes[file] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}
const rustBuildEnvironment = Object.fromEntries(["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_INCREMENTAL", "CARGO_PROFILE_DEV_DEBUG", "SCRIPTC_TARGET"].map(key => [key, rustBuildDefaults[key] ?? process.env[key] ?? null]));
const packageRequire = createRequire(path.join(repo, "packages/compiler/package.json"));
const actualRuntimeRoot = fs.realpathSync(path.dirname(packageRequire.resolve("@scriptc/runtime-rust/package.json")));
const runtimeSourceHashes = Object.fromEntries([...fs.globSync(["src/**/*.rs", "island-v8/src/**/*.rs"], { cwd: actualRuntimeRoot }), "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].filter(file => fs.existsSync(path.join(actualRuntimeRoot, file))).map(file => [file.replaceAll("\\", "/"), crypto.createHash("sha256").update(fs.readFileSync(path.join(actualRuntimeRoot, file))).digest("hex")]));
const metadata = { startedAt: new Date().toISOString(), repo, head: git(["rev-parse", "HEAD"]), branch: git(["branch", "--show-current"]), shards, pattern, inventoryCount: inventory.length, driverExclusions: [...drivers], platform: process.platform, arch: process.arch, node: process.version, oracle, oracleVersion: oracle ? tool(oracle, ["--version"]) : null, node26Oracle, bunOracle, rustc, rustPin, rustBuildEnvironment, actualRuntimeRoot, runtimeSourceHashes, engineSelection: process.env.SCRIPTC_ISLAND_ENGINE ?? "v8", sourceHashes };
metadata.windowsProcessGuard = windowsPython ? { python: windowsPython, version: tool(windowsPython, ["--version"]), processLimit: Number(process.env.SCRIPTC_RUST_JOB_PROCESS_LIMIT ?? "32"), cleanup: "kill all descendants when the executable or its wrapper exits" } : null;
metadata.pathPrefix = [rustc ? path.dirname(rustc) : undefined, oracle ? path.dirname(oracle) : undefined].filter(Boolean);
fs.writeFileSync(path.join(output, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
const tasks = [];
for (let index = 1; index <= shards; index++) {
  const log = fs.openSync(path.join(output, `shard-${index}.log`), "a");
  const env = { ...process.env, SCRIPTC_TEST_SHARD: `${index}/${shards}`, SCRIPTC_TEST_WORKERS: "1", SCRIPTC_NATIVE_WORKERS: "1", SCRIPTC_NATIVE_HOST_WORKERS: process.env.SCRIPTC_NATIVE_HOST_WORKERS ?? "2", CARGO_BUILD_JOBS: "1", SCRIPTC_SAN: "0", SCRIPTC_TEST_DISCARD_PASSED_BINARIES: "1", SCRIPTC_TEST_RUN_ID: stamp, SCRIPTC_RUST_RUN_TIMEOUT_MS: process.env.SCRIPTC_RUST_RUN_TIMEOUT_MS ?? "60000", SCRIPTC_RUST_CASE_REPORT: path.join(output, `shard-${index}-cases.jsonl`), SCRIPTC_RUST_CASE_INVENTORY: path.join(output, "inventory.json"), SCRIPTC_RUST_CORPUS_LEDGER: path.join(output, `shard-${index}-builds.jsonl`) };
  Object.assign(env, rustBuildDefaults);
  if (windowsPython) env.SCRIPTC_RUST_WINDOWS_JOB_PYTHON = windowsPython;
  env.PATH = [...metadata.pathPrefix, process.env.PATH].join(path.delimiter);
  if (oracle) env.SCRIPTC_NODE_ORACLE = oracle;
  if (node26Oracle) env.SCRIPTC_NODE_NODE26 = node26Oracle;
  if (bunOracle) env.SCRIPTC_BUN = bunOracle;
  delete env.SCRIPTC_RUST_SAN;
  const argv = ["node_modules/vitest/vitest.mjs", "run", "tests/harness/rust-differential.test.ts", "--maxWorkers=1", "--reporter=./tests/harness/rust-corpus-reporter.mjs", "--reporter=json", `--outputFile.json=${path.join(output, `shard-${index}.json`)}`, ...(pattern ? ["-t", pattern] : [])];
  const child = spawn(process.execPath, argv, { cwd: repo, env, windowsHide: true, stdio: ["ignore", log, log] });
  tasks.push(new Promise(resolve => { child.on("error", error => { console.error(error); }); child.on("close", code => { fs.closeSync(log); resolve({ index, exit: code }); }); }));
}
console.log(JSON.stringify({ output, inventory: inventory.length, shards }));
const timer = setInterval(() => { try { const matrix = readMatrix(output); console.log(JSON.stringify({ at: new Date().toISOString(), counts: matrix.counts })); } catch {} }, 20000);
const results = await Promise.all(tasks);
clearInterval(timer);
fs.writeFileSync(path.join(output, "completed.json"), JSON.stringify({ finishedAt: new Date().toISOString(), shards: results }, null, 2) + "\n");
const matrix = readMatrix(output);
matrix.metadata.evidenceDirectory = output;
writeMatrix(matrix, output);
console.log(JSON.stringify({ complete: matrix.complete, counts: matrix.counts, failures: matrix.failures }));
process.exitCode = results.some(result => result.exit !== 0) || !matrix.complete || matrix.counts.skipped || matrix.counts["passed-profile-missing"] ? 1 : 0;
