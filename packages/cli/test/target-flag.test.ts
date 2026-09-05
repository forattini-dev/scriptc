import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", tsxLoader, cliEntry, ...args],
      { maxBuffer: 1024 * 1024, env: { ...process.env, SCRIPTC_RUNTIME_TARGET: "" } },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ exitCode: 0, stdout, stderr });
        if (typeof error.code !== "number") return reject(error);
        resolve({ exitCode: error.code, stdout, stderr });
      },
    );
  });
}

test("--target rejects unknown runtime targets by name", async () => {
  const run = await runCli(["coverage", join(repoRoot, "tests/corpus/400-fib.ts"), "--target", "deno"]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('unknown target "deno" (supported: node24, node26, bun)');
});

test("an explicit --target prints no inference note; a project pin does", async () => {
  const explicit = await runCli(["coverage", join(repoRoot, "tests/corpus/400-fib.ts"), "--target", "node26"]);
  expect(explicit.exitCode).toBe(0);
  expect(explicit.stderr).not.toContain("target:");
  // The repository's own .node-version (24.15.0) pins the corpus.
  const inferred = await runCli(["coverage", join(repoRoot, "tests/corpus/400-fib.ts")]);
  expect(inferred.exitCode).toBe(0);
  expect(inferred.stderr).toContain("target: node24 (inferred from .node-version; pass --target to choose)");
});

test("--lib refuses --target", async () => {
  const run = await runCli(["build", "--lib", "--profile", "nope.json", "--target", "bun"]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("takes no --target/--conditions");
});
