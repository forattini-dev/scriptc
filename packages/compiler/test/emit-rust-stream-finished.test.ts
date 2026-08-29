import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function expectDifferential(relativePath: string): Promise<void> {
  const fixture = resolve(relativePath);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-stream-finished-"));
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

  const options = { timeout: 10_000 };
  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), ["--no-warnings", fixture], options),
    execFileAsync(result.binaryPath, [], {
      ...options,
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout, basename(fixture)).toBe(node.stdout);
  expect(rust.stderr, basename(fixture)).toBe(node.stderr);
}

test("Rust stream.finished supports terminal status and cleanup", async () => {
  await expectDifferential("tests/corpus/1813-stream-finished.ts");
});

test("Rust stream.finished supports checked-dynamic function values", async () => {
  await expectDifferential("tests/fixtures/stream/cases/finished-function-value/main.cjs");
});

test("Rust stream argument ladders and socket encoding match Node", async () => {
  await expectDifferential("tests/corpus/2599-stream-arg-ladders.cjs");
});
