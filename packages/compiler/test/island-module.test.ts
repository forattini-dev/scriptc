import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { analyze, compile, writeProjectTiers } from "../src/index.js";

const entry = resolve("packages/compiler/test/fixtures/island-module/src/main.ts");

/* The static frontier, explicit form: a program module named by
 * --island-module leaves the static tier — its diagnostics vanish, the
 * coverage report lists it as island with the reason, and static code
 * reaches its exports through engine handles. */
test("an --island-module program module stops blocking the build and shows in the frontier", () => {
  const blocked = analyze(entry, { dynamic: true });
  expect(blocked.coverage.diagnostics.some((d) => d.loc.file.endsWith("proxied.ts"))).toBe(true);
  expect(blocked.coverage.tiers).toBeUndefined();

  const tiered = analyze(entry, { dynamic: true, islandModules: ["src/proxied.ts"] });
  expect(tiered.coverage.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  expect(tiered.coverage.tiers?.map((t) => [t.module.split("/").pop(), t.tier])).toEqual([
    ["proxied.ts", "island"],
    ["main.ts", "static"],
  ]);
});

test("--island-module auto moves the blocked module by itself and names the blocker", () => {
  const { coverage } = analyze(entry, { dynamic: true, islandModules: ["auto"] });
  expect(coverage.diagnostics).toEqual([]);
  const island = coverage.tiers?.filter((t) => t.tier === "island");
  expect(island?.map((t) => t.module.split("/").pop())).toEqual(["proxied.ts"]);
  expect(island?.[0]?.reason).toContain("auto: round 1: SC2020 'new Proxy'");
});

test("--write-tiers persists the frontier into scriptc.json, which later builds pin without a fixpoint", () => {
  const config = resolve("packages/compiler/test/fixtures/island-module/scriptc.json");
  try {
    analyze(entry, { dynamic: true, islandModules: ["auto"] });
    expect(writeProjectTiers()).toBe(config);
    const written = JSON.parse(readFileSync(config, "utf8")) as { tiers: { island: { module: string; reason: string }[] } };
    expect(written.tiers.island.map((r) => r.module)).toEqual(["src/proxied.ts"]);
    expect(written.tiers.island[0]?.reason).toContain("SC2020 'new Proxy'");
    // No flag at all: the pin alone classifies the module.
    const pinnedRun = analyze(entry, { dynamic: true });
    expect(pinnedRun.coverage.diagnostics).toEqual([]);
    expect(pinnedRun.coverage.tiers?.find((t) => t.module.endsWith("proxied.ts"))?.reason).toContain("pinned (scriptc.json)");
  } finally {
    if (existsSync(config)) rmSync(config);
  }
});

test("a static build refuses --island-module without --dynamic at the import", () => {
  const { coverage } = analyze(entry, { islandModules: ["src/proxied.ts"] });
  expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(true);
});

test("the island module's exports bind as handles and run (rust)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-island-module-"));
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    optimization: "dev",
    dynamic: true,
    islandModules: ["**/proxied.ts"],
  });
  expect(result.ok, result.ok ? "" : result.diagnostics.map((d) => d.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const run = await new Promise<{ stdout: string; code: number }>((done) => {
    execFile(result.binaryPath, { encoding: "utf8", env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }, (error, stdout) => {
      done({ stdout, code: error && typeof error.code === "number" ? error.code : 0 });
    });
  });
  expect(run.code).toBe(0);
  expect(run.stdout).toBe("<x> 42\n");
});
