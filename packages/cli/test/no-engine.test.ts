import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("coverage and build reject an engine requirement through the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-cli-no-engine-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, 'console.log(__island_eval("1 + 2"));');
    for (const command of ["coverage", "build"]) {
      const result = spawnSync(process.execPath, [
        "--import", "tsx", resolve("packages/cli/src/main.ts"), command,
        entry, "--backend", "rust", "--dynamic", "--no-engine",
      ], { encoding: "utf8", timeout: 60_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain("SC3003");
      expect(result.stdout + result.stderr).toContain("--no-engine");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
