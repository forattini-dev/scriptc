import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";

test("Rust pending entry preserves explicit exit codes and exit listener overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-entry-exit-"));
  try {
    const entry = join(directory, "main.mts");
    await writeFile(entry, `
const initial = process.argv[2];
const override = process.argv[3];
const pending = process.argv[4] === "pending";
if (initial !== "none") process.exitCode = Number(initial);
process.on("exit", (code: number) => {
  console.log("exit", code);
  if (override !== "none") process.exitCode = Number(override);
});
await new Promise<void>((resolve) => { if (!pending) resolve(); });
`);
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization: "dev",
      outDir: directory, outPath: join(directory, "program"),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    for (const state of ["pending", "fulfilled"]) {
      for (const initial of ["none", "0", "5"]) {
        for (const override of ["none", "0", "7"]) {
          const args = [initial, override, state];
          // Suppress Node's source-location warning explicitly, without
          // normalizing stderr or masking native runtime/heap diagnostics.
          const node = spawnSync(nodeOracleExecutable(), ["--no-warnings", entry, ...args], { encoding: "utf8", timeout: 10000 });
          const rust = spawnSync(result.binaryPath, args, {
            encoding: "utf8", timeout: 10000,
            env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
          });
          const observed = state === "pending" && initial !== "5" ? 13 : initial === "5" ? 5 : 0;
          expect(node.error, args.join("/")).toBeUndefined();
          expect(node.status).toBe(override === "none" ? observed : Number(override));
          expect(node.stdout).toBe(`exit ${observed}\n`);
          expect(node.stderr).toBe("");
          expect.soft(rust.error, args.join("/")).toBeUndefined();
          expect.soft({ status: rust.status, signal: rust.signal, stdout: rust.stdout, stderr: rust.stderr }, args.join("/")).toEqual({
            status: node.status, signal: node.signal, stdout: node.stdout, stderr: node.stderr,
          });
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
