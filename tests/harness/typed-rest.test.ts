import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, renderDiagnostics } from "@scriptc/compiler";
import { nodeOracleExecutable, nodeTransformTypesArgs } from "./oracle-environment.js";

test.for(["3253-typed-rest-function-values.ts", "3254-typed-rest-record-values.ts"])(
  "typed rest %s stays native with Node parity", async file => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-typed-rest-"));
    try {
      const entry = join(import.meta.dirname, "../corpus", file);
      const result = await compile(entry, { backend: "rust", allowEngine: false,
        optimization: "dev", outDir: dir, outPath: join(dir, "program") });
      expect(result.ok, result.ok ? "" : renderDiagnostics(result.diagnostics, result.sourceTexts, { color: false })).toBe(true);
      if (!result.ok) return;
      expect(result.execution.engine).toBe("none");
      expect(result.runtimeFences).toEqual([]);
      const oracle = spawnSync(nodeOracleExecutable(), [...nodeTransformTypesArgs(nodeOracleExecutable(),
        new URL("./transform-types-hook.mjs", import.meta.url).href), entry], { timeout: 30_000 });
      const native = spawnSync(result.binaryPath, [], { timeout: 30_000,
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
      expect(oracle.error).toBeUndefined();
      expect(native.error).toBeUndefined();
      expect(oracle.status).toBe(0);
      expect(native.status).toBe(oracle.status);
      expect(native.signal).toBeNull();
      expect(native.stdout).toEqual(oracle.stdout);
      expect(native.stderr).toEqual(oracle.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);
