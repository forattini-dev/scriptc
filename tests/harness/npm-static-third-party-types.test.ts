import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

// This npm corpus needs AUTO, like the existing npm-static pilots. Keep
// the same original TS entry for the Node oracle and the native compiler.
test("AUTO compiles installed third-party types to an engine-free Rust binary", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-native-third-party-"));
  const entry = join(import.meta.dirname, "../fixtures/npm-static/third-party-types/main.ts");
  try {
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, npmStatic: "auto", typeAcquisition: { mode: "local" },
      outDir, outPath: join(outDir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000, env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
    const node = spawnSync(nodeOracleExecutable(), [entry], { encoding: "utf8", timeout: 30_000 });
    expect(native.error).toBeUndefined();
    expect(node.error).toBeUndefined();
    expect([native.stdout, native.stderr, native.status]).toEqual([node.stdout, node.stderr, node.status]);
    expect(native.stdout).toBe("native 42\n");
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
