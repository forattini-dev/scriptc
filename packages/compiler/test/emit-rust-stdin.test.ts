import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runWithClosedStdin(file: string, args: string[], env = process.env): Promise<ProcessOutcome> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`stdin fixture timed out: ${file}`));
    }, 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveRun({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

test("Rust stdin listeners and for-await observe a closed pipe like Node", async () => {
  const fixture = resolve("tests/corpus/1447-stdin-closed-events.ts");
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-rust-stdin-"));
  const result = await compile(fixture, {
    outDir,
    outPath: join(outDir, "stdin-closed-events"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    runWithClosedStdin(nodeOracleExecutable(), [fixture]),
    runWithClosedStdin(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
  ]);
  expect(rust).toEqual(node);
}, 120_000);
