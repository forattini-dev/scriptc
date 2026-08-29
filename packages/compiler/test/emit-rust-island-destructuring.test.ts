import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runToExit(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProcessOutcome> {
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
  ["2054-destructuring-island-source.ts", 0, null],
  [
    "2074-island-destructuring.ts",
    1,
    "Uncaught TypeError: Cannot destructure 'a' as it is undefined.",
  ],
  ["2101-dyn-param-defaults.ts", 0, null],
  ["2104-computed-key-destructuring.ts", 0, null],
] as const)("Rust island destructuring matches Node: %s", async (
  fixtureName,
  expectedExit,
  expectedUncaught,
) => {
  const fixture = resolve("tests/corpus", fixtureName);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-island-destructure-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    dynamic: true,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [fixture], process.env),
    runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
  ]);
  expect(node.exitCode).toBe(expectedExit);
  expect(rust.exitCode).toBe(expectedExit);
  expect(rust.stdout).toBe(node.stdout);
  if (expectedUncaught === null) expect(rust.stderr).toBe(node.stderr);
  else expect(rust.stderr).toBe(`${expectedUncaught}\n`);
  expect(rust.stderr).not.toContain("Rust heap object(s) still live");
}, 240_000);
