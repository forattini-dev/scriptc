#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const rawCommand = process.argv.slice(2);
const command = rawCommand[0] === "--" ? rawCommand.slice(1) : rawCommand;
if (command.length === 0) {
  process.stderr.write("usage: pnpm limit -- <command> [args...]\n");
  process.exit(2);
}

const properties = [
  `CPUQuota=${process.env.SCRIPTC_LIMIT_CPU ?? "50%"}`,
  `MemoryHigh=${process.env.SCRIPTC_LIMIT_MEMORY_HIGH ?? "2G"}`,
  `MemoryMax=${process.env.SCRIPTC_LIMIT_MEMORY ?? "3G"}`,
  "MemorySwapMax=0",
  "IOWeight=1",
  "IOSchedulingClass=idle",
  "Nice=19",
  `TasksMax=${process.env.SCRIPTC_LIMIT_TASKS ?? "256"}`,
];
const cacheRoot = process.env.SCRIPTC_CACHE_DIR ?? join(homedir(), ".cache", "scriptc");
const temporaryRoot = process.env.TMPDIR ?? join(homedir(), ".cache", "scriptc-test-tmp");
const cargoTarget = process.env.CARGO_TARGET_DIR ?? join(cacheRoot, "cargo-target");
mkdirSync(temporaryRoot, { recursive: true });
mkdirSync(cargoTarget, { recursive: true });

const environment = {
  PATH: process.env.PATH,
  TMPDIR: temporaryRoot,
  SCRIPTC_CACHE_DIR: cacheRoot,
  CARGO_TARGET_DIR: cargoTarget,
  SCRIPTC_TEST_WORKERS: process.env.SCRIPTC_TEST_WORKERS ?? "1",
  SCRIPTC_NATIVE_JOBS: process.env.SCRIPTC_NATIVE_JOBS ?? "1",
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "1",
};
const args = [
  "--user", "--pipe", "--wait", "--collect", "--quiet",
  `--working-directory=${process.cwd()}`,
];
for (const property of properties) args.push("--property", property);
for (const [name, value] of Object.entries(environment)) {
  if (value !== undefined) args.push("--setenv", `${name}=${value}`);
}
args.push("--", ...command);

const result = spawnSync("systemd-run", args, { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`scriptc resource limiter failed: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
