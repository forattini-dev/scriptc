import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

interface Outcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runToExit(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  return new Promise((resolveRun) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout, stderr) => {
      resolveRun({
        stdout,
        stderr,
        exitCode: error && typeof error.code === "number" ? error.code : 0,
      });
    });
  });
}

test.each([
  "1700-mustcall-common/main.cjs",
  "1701-mustcall-exit-report/main.cjs",
])("Rust stackless Error inspection matches Node: %s", async (fixtureName) => {
  const fixture = resolve("tests/corpus", fixtureName);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-inspect-error-"));
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
    runToExit(process.execPath, [fixture]),
    runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
  expect(rust.exitCode).toBe(node.exitCode);
});
