import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "../../compiler/src/type-acquisition/fixtures.js";

const cli = join(import.meta.dirname, "../dist/main.js");

test("CLI exposes local and offline typing diagnostics and rejects invalid modes", () => {
  const root = fixture();
  const entry = join(root, "main.ts");
  const offline = spawnSync(process.execPath, [cli, "coverage", entry, "--types-mode=offline", "--types-cache", join(root, "cache")], { encoding: "utf8", timeout: 30_000 });
  expect(offline.error).toBeUndefined();
  expect(offline.status).toBe(1);
  expect(offline.stdout).toContain("SC4030");
  expect(offline.stdout).toContain("lock miss");
  const local = spawnSync(process.execPath, [cli, "coverage", entry, "--types-mode=local"], { encoding: "utf8", timeout: 30_000 });
  expect(local.status).toBe(1);
  expect(local.stdout).not.toContain("SC4030");
  expect(local.stdout).toContain("declaration file");
  const invalid = spawnSync(process.execPath, [cli, "coverage", entry, "--types-mode=wrong"], { encoding: "utf8", timeout: 30_000 });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("--types-mode must be auto, local or offline");
});
