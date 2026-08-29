import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

function runWithClosedStdin(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolveRun({ stdout, stderr, exitCode }));
  });
}

test("Rust readline closes on stdin EOF like Node", async () => {
  const fixture = resolve("tests/corpus/1475-readline-closed-stdin.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-readline-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    runWithClosedStdin(nodeOracleExecutable(), [fixture]),
    runWithClosedStdin(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
  expect(rust.exitCode).toBe(node.exitCode);
});
