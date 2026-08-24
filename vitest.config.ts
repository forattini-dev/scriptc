import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Compiled-binary + oracle caches for the test lanes (see cc.ts's cache block
// and tests/harness/README.md). Workers inherit SCRIPTC_CACHE_DIR from here;
// SCRIPTC_NO_CACHE=1 in the caller's environment bypasses every cache in both
// directions (no reads, no writes). Production builds use the platform cache;
// this explicit override keeps test artifacts repo-local and disposable.
const configuredCacheDir = process.env["SCRIPTC_CACHE_DIR"];
const cacheDir =
  configuredCacheDir ??
  fileURLToPath(new URL("./node_modules/.cache/scriptc-tests/cas", import.meta.url));
const testTmpDir =
  process.env["TMPDIR"] ??
  join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "scriptc", "test-tmp");

// The production cache refuses an existing explicit override that is visible
// to other users. This repository owns the default test-only override, so
// create (or repair) it before any oracle subdirectory can implicitly create
// the root with the process umask (normally 0755). Otherwise native caching is
// silently disabled and every corpus case recompiles the complete C runtime.
if (configuredCacheDir === undefined && process.env["SCRIPTC_NO_CACHE"] !== "1") {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(cacheDir, 0o700);
}
if (process.platform !== "win32") mkdirSync(testTmpDir, { recursive: true });

// Native differential tests are memory-heavy, so two workers is the safe host
// default. CI and larger machines can override it explicitly.
const configuredWorkers = process.env["SCRIPTC_TEST_WORKERS"] ?? "2";
const workers = Number(configuredWorkers);
if (!Number.isInteger(workers) || workers < 1) {
  throw new Error("SCRIPTC_TEST_WORKERS must be a positive integer");
}

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against compiler source directly — no build step needed.
      "@scriptc/compiler": fileURLToPath(
        new URL("./packages/compiler/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "tests/harness/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
    ],
    // Differential tests spawn clang + binaries; give them room. 300s is a
    // hang detector, not a performance bound: under a merge gate sharing
    // the box with lane compiles, a legitimately compile-heavy corpus
    // entry can starve past 120s (1751 timed out twice on 2026-07-20 while
    // passing in 3s isolated and uncached).
    testTimeout: 300_000,
    hookTimeout: 300_000,
    env: {
      SCRIPTC_CACHE_DIR: cacheDir,
      ...(process.platform === "win32" ? {} : { TMPDIR: testTmpDir }),
      SCRIPTC_NATIVE_WORKERS: process.env["SCRIPTC_NATIVE_WORKERS"] ?? "2",
      CARGO_BUILD_JOBS: process.env["CARGO_BUILD_JOBS"] ?? "1",
      // The differential lanes run against one immutable checkout/toolchain
      // per worker. Reuse expensive compiler/linker metadata probes inside
      // that session; cc.test.ts removes this flag to keep exercising
      // production's fresh-probe invalidation guarantees.
      SCRIPTC_TEST_STABLE_TOOLCHAIN:
        process.env["SCRIPTC_TEST_STABLE_TOOLCHAIN"] ?? "1",
    },
    maxWorkers: workers,
    minWorkers: 1,
    globalSetup: ["./tests/harness/suite-lock.mjs"],
  },
});
