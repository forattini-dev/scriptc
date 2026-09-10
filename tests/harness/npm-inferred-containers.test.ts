import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, NODE_COMPAT_MATRIX } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";

const entry = join(import.meta.dirname, "../fixtures/npm-static/inferred-lines-cli.ts");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
for (const backend of ["rust", "c", "llvm"] as const) {
  test.skipIf(sanitize && backend === "rust")(`${backend} retains array properties after npm string specialization`, async () => {
    const outDir = mkdtempSync(join(tmpdir(), `scriptc-npm-inferred-${backend}-`));
    try {
      const result = await compile(entry, {
        backend, sanitize, allowEngine: false, npmStatic: "auto",
        optimization: "dev", outDir, outPath: join(outDir, "program"),
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.execution.engine).toBe("none");
      const node = spawnSync(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
      const native = spawnSync(result.binaryPath, []);
      expect(node.error).toBeUndefined();
      expect(node.status).toBe(0);
      expect(native.error).toBeUndefined();
      expect(native.signal).toBeNull();
      expect(native.status).toBe(node.status);
      expect(native.stdout.toString()).toBe(node.stdout.toString());
      expect(native.stderr.toString()).toBe(node.stderr.toString());
    } finally { rmSync(outDir, { recursive: true, force: true }); }
  }, 120_000);
}
