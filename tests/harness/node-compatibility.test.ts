import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const snapshot = JSON.parse(
  readFileSync(join(repoRoot, "internal/compatibility/generated/node-v24-internal.json"), "utf8"),
) as {
  rows: Array<{
    chapter: string;
    apiSymbol: string;
    static?: { evidence?: string };
  }>;
};

describe("Node compatibility generator", () => {
  test("recomputes current artifacts offline from the pinned census", async () => {
    const artifacts = [
      "internal/compatibility/generated/node-v24-internal.json",
      "internal/compatibility/generated/node-v24-backlog.json",
      "docs/src/generated/node-v24-compatibility.json",
      "docs/src/generated/node-v24-compatibility-meta.json",
    ];
    const before = artifacts.map(path => readFileSync(join(repoRoot, path), "utf8"));
    await promisify(execFile)(process.execPath, [
      join(repoRoot, "internal/compatibility/src/generate.mjs"), "--offline", "--check",
    ], { timeout: 10_000 });
    expect(artifacts.map(path => readFileSync(join(repoRoot, path), "utf8"))).toEqual(before);
  });

  test("does not attribute bare fs APIs to fs/promises lowering", () => {
    const bareFsRows = snapshot.rows.filter((row) => row.chapter === "fs" && row.apiSymbol.startsWith("fs."));

    expect(bareFsRows.length).toBeGreaterThan(0);
    expect(bareFsRows.every((row) => !row.static?.evidence?.includes("fs.promises"))).toBe(true);
  });

  test("keeps fsPromises APIs attributed to fs/promises lowering", () => {
    const promiseRows = snapshot.rows.filter((row) => row.chapter === "fs" && row.apiSymbol.startsWith("fsPromises."));

    expect(promiseRows.length).toBeGreaterThan(0);
    expect(promiseRows.some((row) => row.static?.evidence?.includes("node-builtin.fs.promises"))).toBe(true);
  });

  test("publishes implementation-owned DNS scope without broadening dynamic claims", () => {
    const artifact = JSON.parse(readFileSync(join(repoRoot, "docs/src/generated/node-v24-compatibility.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(repoRoot, "internal/compatibility/static-support.json"), "utf8"));
    const scope = manifest.features.find((feature: { chapter: string; signatures?: string[] }) =>
      feature.chapter === "dns" && feature.signatures?.includes("`dnsPromises.lookup(hostname[, options])`"));
    const row = artifact.rows.find((row: { chapter: string; apiSymbol: string }) => row.chapter === "dns" && row.apiSymbol === "dnsPromises.lookup");
    expect(row).toBeDefined();
    expect(row.static.status).toBe("partial");
    expect(row.static.detail).toBe(scope.publicDetail);
    expect(row.static.verification).toBe("test-backed");
    expect(row.dynamic.status).toBe("refused");
    expect(JSON.stringify(row)).not.toContain("tests/");
    expect(JSON.stringify(row)).not.toContain("compiler-feature:");
  });
});
