import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Opt-in scratch cleanup, called only after every test assertion passed.
 * Retain a digest receipt and generated sources; never evict failed cases,
 * production caches, or consumer acceptance artifacts. */
export function discardPassedBinary(root: string, binary: string, test: string): void {
  if (process.env["SCRIPTC_TEST_DISCARD_PASSED_BINARIES"] !== "1") return;
  const path = resolve(binary);
  const child = relative(realpathSync(root), realpathSync(path));
  if (!child || child === ".." || child.startsWith("../") || child.startsWith("..\\") || isAbsolute(child)) {
    throw new Error(`passed binary is outside the corpus scratch directory: ${path}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`passed binary must be a regular file: ${path}`);
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(`${path}.passed.json`, JSON.stringify({ test, binary: child, bytes: stat.size, sha256, runId: process.env["SCRIPTC_TEST_RUN_ID"], passedAt: new Date().toISOString() }, null, 2) + "\n");
  unlinkSync(path);
}
