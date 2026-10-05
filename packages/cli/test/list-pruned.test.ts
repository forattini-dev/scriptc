import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

function coverage(listPruned: boolean): string {
  const env = { ...process.env };
  delete env["SCRIPTC_LIST_PRUNED"];
  if (listPruned) env["SCRIPTC_LIST_PRUNED"] = "1";
  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve("packages/cli/src/main.ts"), "coverage",
    resolve("tests/corpus/3470-npm-named-reexport-pruning/main.ts"),
    "--backend", "rust", "--no-engine", "--npm-static", "auto", "--target", "node26",
  ], { encoding: "utf8", timeout: 120_000, env });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

test("coverage counts the npm modules a program never evaluates, and lists them under SCRIPTC_LIST_PRUNED=1", () => {
  const count = "pure-barrel  static (4 modules not evaluated: unused re-exports of a sideEffects-free package)";
  const plain = coverage(false);
  expect(plain).toContain(count);
  expect(plain).not.toContain("- fenced.js");

  const listed = coverage(true);
  expect(listed).toContain(count);
  expect(listed).toContain("- beta.js\n      - chain/spare.js\n      - fenced.js\n      - meta-extra.js");
});
