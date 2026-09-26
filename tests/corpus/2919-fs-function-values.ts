// The fixed-signature node:fs functions are ordinary static values. Named,
// namespace, and CommonJS reads share identity; values flow through
// parameters, returns, arrays, and records without bypassing the direct
// calls' filesystem behavior. APIs with behavior-bearing trailing options
// remain call-only (diagnostics/stdlib.ts).
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const cjsFs = require("node:fs") as typeof import("node:fs");
const root = join(tmpdir(), `scriptc-fs-values-${process.pid}`);
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });

function callPathBool(fn: (path: string) => boolean, path: string): boolean {
  return fn(path);
}

function callPathVoid(fn: (path: string) => void, path: string): void {
  fn(path);
}

function callPathPair(fn: (from: string, to: string) => void, from: string, to: string): void {
  fn(from, to);
}

function callPathIds(fn: (path: string, uid: number, gid: number) => void, path: string): void {
  fn(path, -1, -1);
}

function chooseExists(cjs: boolean): (path: string) => boolean {
  return cjs ? cjsFs.existsSync : existsSync;
}

console.log(
  existsSync === fs.existsSync,
  existsSync === cjsFs.existsSync,
  chownSync === fs.chownSync,
  typeof existsSync,
);
console.log(!callPathBool(chooseExists(false), root));

mkdirSync(root);
const file = join(root, "source.txt");
writeFileSync(file, "alpha", { mode: 0o600 });
const moved = join(root, "moved.txt");
callPathPair(renameSync, file, moved);
console.log(callPathBool(existsSync, moved), !callPathBool(existsSync, file));

const modes: ((path: string, mode: number) => void)[] = [chmodSync];
modes[0]!(moved, 0o600);
callPathIds(chownSync, moved);
const fd = openSync(moved, "r");
((close: (fd: number) => void): void => close(fd))(closeSync);

const operations: { exists: (path: string) => boolean; unlink: (path: string) => void } = {
  exists: fs.existsSync,
  unlink: fs.unlinkSync,
};
console.log(operations.exists(moved));
operations.unlink(moved);
const disposable = join(root, "disposable.txt");
writeFileSync(disposable, "gone");
callPathVoid(unlinkSync, disposable);
console.log(!existsSync(moved), !existsSync(disposable));

rmSync(root, { recursive: true, force: true });
console.log(!existsSync(root));
