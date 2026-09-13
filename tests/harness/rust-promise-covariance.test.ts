import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

test("Rust preserves covariant Promise callbacks", async () => {
  const entry = join(import.meta.dirname, "../fixtures/promise-covariance/main.ts");
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-promise-covariance-"));
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000, env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
    const node = spawnSync(nodeOracleExecutable(), [entry], { encoding: "utf8", timeout: 30_000 });
    expect(native.error).toBeUndefined();
    expect(node.error).toBeUndefined();
    expect(node.status).toBe(0);
    expect([native.stdout, native.stderr, native.status]).toEqual([node.stdout, node.stderr, node.status]);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
