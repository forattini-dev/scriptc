import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

test.for(["rust", "c", "llvm"] as const)("type-only npm exports match Node with backend %s and no engine", async (backend) => {
  const entry = resolve("tests/fixtures/npm-static/type-exports-cli.ts");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-native-type-exports-"));
  try {
    const result = await compile(entry, {
      outDir: dir, outPath: join(dir, "program"), backend,
      npmStatic: "auto", allowEngine: false, optimization: "dev",
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, result.ok ? "" : result.diagnostics.map((d) => d.message).join("\n")).toBe(true);
    if (!result.ok) return;
    const node = spawnSync(nodeOracleExecutable(), [entry], { timeout: 30_000 });
    const native = spawnSync(result.binaryPath, [], { timeout: 30_000 });
    expect(node.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    expect(node.status).toBe(0);
    expect(native.signal).toBeNull();
    expect(native.status).toBe(node.status);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
