import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { npmOracleFlags } from "./npm-cases.js";
import { nodeOracleExecutable } from "./oracle-environment.js";

test.each([true, false])("npm deprecation opt-in retains ordinary warnings and stderr: %s", (optIn) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-oracle-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(entry, `${optIn ? "// @no-deprecation" : "// @no-warnings"}
console.error("explicit stderr");
process.emitWarning("ordinary warning");
process.emitWarning("deprecated API", "DeprecationWarning");
`);
    const result = spawnSync(nodeOracleExecutable(), [...npmOracleFlags(entry), entry], {
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("explicit stderr\n");
    expect(result.stderr).toContain("Warning: ordinary warning\n");
    expect(result.stderr.includes("DeprecationWarning: deprecated API")).toBe(!optIn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
