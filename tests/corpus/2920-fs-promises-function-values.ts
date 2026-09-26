// Fixed-signature node:fs/promises functions retain their Promise result
// when stored, returned, and passed through ordinary typed function slots.
// Promise APIs with behavior-bearing trailing options remain call-only.
import { chmod, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const cjsFsp = require("node:fs/promises") as typeof import("node:fs/promises");
const root = join(tmpdir(), `scriptc-fsp-values-${process.pid}`);
if (existsSync(root)) rmSync(root, { recursive: true, force: true });

const unlinkPath: (path: string) => Promise<void> = unlink;
const namespaceUnlinkPath: (path: string) => Promise<void> = fsp.unlink;
const cjsUnlinkPath: (path: string) => Promise<void> = cjsFsp.unlink;
const changeMode: (path: string, mode: number) => Promise<void> = chmod;
const renamePath: (from: string, to: string) => Promise<void> = rename;

async function callPathVoid(fn: (path: string) => Promise<void>, path: string): Promise<void> {
  await fn(path);
}

async function callPathPair(
  fn: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
): Promise<void> {
  await fn(from, to);
}

function chooseUnlink(cjs: boolean): (path: string) => Promise<void> {
  return cjs ? cjsUnlinkPath : unlinkPath;
}

console.log(
  unlinkPath === namespaceUnlinkPath,
  unlinkPath === cjsUnlinkPath,
  typeof unlinkPath,
);

await mkdir(root);
const first = join(root, "first.txt");
const second = join(root, "second.txt");
await writeFile(first, "promise-value", { mode: 0o600 });
await writeFile(second, "second");

const names = await readdir(root);
console.log(names.sort().join(","));
const snapshot: Stats = await stat(first);
console.log(snapshot.isFile(), snapshot.size);

await changeMode(first, 0o600);
const renamed = join(root, "renamed.txt");
await callPathPair(renamePath, second, renamed);
console.log(existsSync(renamed), !existsSync(second));

await callPathVoid(chooseUnlink(false), renamed);
console.log(!existsSync(renamed));

try {
  await callPathVoid(unlinkPath, join(root, "missing"));
} catch (error) {
  console.log(error instanceof Error, error instanceof Error && error.message.includes("ENOENT"));
}

rmSync(root, { recursive: true, force: true });
console.log(!existsSync(root));
