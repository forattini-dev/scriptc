import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

interface RunOutcome { stdout: string; stderr: string; exitCode: number }

function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv, input?: string): Promise<RunOutcome> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); rejectRun(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) return rejectRun(new Error(`${file} terminated by ${signal}`));
      resolveRun({ stdout, stderr, exitCode: code ?? 1 });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function expectDifferential(relativePath: string, dynamic = true, input?: string): Promise<void> {
  const fixture = resolve(relativePath);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dynamic-import-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    dynamic,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    run(nodeOracleExecutable(), ["--no-warnings", fixture], undefined, input),
    run(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }, input),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
  expect(rust.exitCode).toBe(node.exitCode);
}

test.for([
  "tests/corpus/2050-dynamic-import-own-module/main.ts",
  "tests/corpus/2051-dynamic-import-then/main.ts",
  "tests/corpus/2052-dynamic-import-self.ts",
  "tests/corpus/2606-dynamic-import-cycle/main.ts",
])("Rust own-module import matches Node: %s", expectDifferential);

test.for([
  "tests/corpus/2650-top-level-await-self-import.ts",
  "tests/corpus/2652-top-level-await-dynamic/main.ts",
  "tests/corpus/2657-top-level-await-cycle-dynamic/main.ts",
  "tests/corpus/2659-top-level-await-dynamic-cycle/main.ts",
  "tests/corpus/2660-top-level-await-cycle-rejection/main.ts",
  "tests/corpus/2661-top-level-await-dynamic-runtime-root/main.ts",
])("Rust async own-module import matches Node: %s", expectDifferential);

test("Rust top-level for-await matches Node", async () =>
  expectDifferential("tests/corpus/2674-top-level-for-await-implicit-module.ts", false, "alpha\nbeta\n"));

test("Rust any-array copying sort matches Node", async () =>
  expectDifferential("tests/corpus/2667-array-to-sorted-any.ts"));
