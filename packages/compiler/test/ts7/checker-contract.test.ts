import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("the packaged checker satisfies the migration contract with an actual server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-checker-contract-"));
  const output = join(directory, "result");
  try {
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    const result = await promisify(execFile)(process.execPath,
      [join(root, "scripts/checker-contract.mjs"), "--out-dir", output],
      { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true })
      .catch(error => { throw new Error(`checker contract failed:\n${error.stdout}\n${error.stderr}`, { cause: error }); });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "PASS", checkers: 1, cases: 17, failures: [] });
    const report = JSON.parse(readFileSync(join(output, "results.json"), "utf8"));
    expect(report.results[0]).toMatchObject({ ok: true, timedOut: false, exit: { code: 0, signal: null } });
    expect(report.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
