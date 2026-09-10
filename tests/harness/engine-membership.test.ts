import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { compile } from "@scriptc/compiler";
import { expect, test } from "vitest";

const run = promisify(execFile);
const entry = resolve(import.meta.dirname, "../corpus/3168-island-membership-proxy/main.ts");
const engineModule = resolve(import.meta.dirname, "../corpus/3168-island-membership-proxy/proxy-impl.ts");

// Explicit island-module fixtures are owned by the Rust corpus sweep; cover
// the C runtime and both of its emitters here, including the sanitized lane.
test.each(["c", "llvm"] as const)("%s preserves proxy membership and catchable has traps", async (backend) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-engine-membership-"));
  try {
    const result = await compile(entry, {
      backend, dynamic: true, islandModules: [engineModule],
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir: directory, outPath: join(directory, "program"),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const oracle = await run(process.execPath, [entry]);
    expect(oracle.stdout).toBe("true false\ncaught has trap\nliteral has trap\n");
    expect(oracle.stderr).toBe("");
    const native = await run(result.binaryPath, []);
    expect(native.stdout).toBe(oracle.stdout);
    expect(native.stderr).toBe(oracle.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
