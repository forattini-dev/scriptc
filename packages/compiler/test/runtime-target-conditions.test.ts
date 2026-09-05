import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

function runToExit(file: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolveRun) => {
    execFile(file, { encoding: "utf8", env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }, (error, stdout) => {
      resolveRun({ stdout, exitCode: error && typeof error.code === "number" ? error.code : 0 });
    });
  });
}

/* The --target profile decides which arm of a package.json "imports"
 * (or "exports") condition map the compiled graph embeds — the same arm
 * the runtime itself would pick: Bun matches "bun" then "node", Node
 * matches "node". A resolver carrying neither would fall to "default",
 * which is what the fixture's third arm pins as the wrong answer. */
test.each([
  ["bun", "bun"],
  ["node24", "node"],
  ["node26", "node"],
] as const)("--target %s resolves the imports map's %s arm (rust)", async (target, expected) => {
  const fixture = resolve("packages/compiler/test/fixtures/runtime-target/src/main.ts");
  const dir = await mkdtemp(join(tmpdir(), `scriptc-runtime-target-${target}-`));
  const result = await compile(fixture, {
    target,
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? fixture : result.diagnostics.map((d) => d.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const run = await runToExit(result.binaryPath);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe(`${expected}\n`);
});
