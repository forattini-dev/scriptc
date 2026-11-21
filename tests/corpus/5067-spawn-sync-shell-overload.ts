/// <reference types="node" />
import { spawnSync } from "node:child_process";

const result = spawnSync("echo shell-ok", {
  cwd: process.cwd(),
  shell: true,
  encoding: "utf8",
  env: { ...process.env, SCRIPTC_SHELL_TEST: "kept" },
});

console.log(result.status ?? -1);
console.log(result.stdout.trim());
console.log(result.stderr.trim());
