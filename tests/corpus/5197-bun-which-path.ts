// @rust-only
// @target bun
// @no-engine
/// <reference path="./rust-bun-which/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = `.scriptc-which-${process.pid}`;
const first = join(root, "first");
const second = join(root, "second");
mkdirSync(first, { recursive: true });
mkdirSync(second, { recursive: true });
const command = process.platform === "win32" ? "scriptc-which.cmd" : "scriptc-which";
const executable = join(second, command);
const separator = process.platform === "win32" ? ";" : ":";
writeFileSync(executable, process.platform === "win32" ? "@exit /b 0\n" : "#!/bin/sh\nexit 0\n");
if (process.platform !== "win32") chmodSync(executable, 0o700);
const found = Bun.which(command, { PATH: first + separator + second });
console.log(found === executable);
rmSync(root, { recursive: true, force: true });
