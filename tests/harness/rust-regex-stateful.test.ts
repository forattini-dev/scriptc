import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

test.each(["regex-stateful/main.ts", "npm-static/is-extglob-native/main.ts"])("Rust regex parity: %s", async (program) => {
  const entry = join(import.meta.dirname, "../fixtures", program);
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-regex-state-"));
  try {
    const result = await compile(entry, { backend: "rust", allowEngine: false, npmStatic: "auto", typeAcquisition: { mode: "local" }, outDir, outPath: join(outDir, "program") });
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
