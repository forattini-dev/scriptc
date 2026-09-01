import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function expectRustToMatchNode(fixtureName: string, expectedStdout: string): Promise<void> {
  const fixture = resolve(`tests/corpus/${fixtureName}`);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dyn-string-starts-with-"));
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
    execFileAsync(nodeOracleExecutable(), [fixture]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(node.stdout).toBe(expectedStdout);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}

test("Rust dynamic String.prototype.startsWith honors position", async () => {
  await expectRustToMatchNode("2828-dyn-string-starts-with-position.cjs", "true\n");
});

test("Rust dynamic String.prototype.startsWith treats a missing search as undefined", async () => {
  await expectRustToMatchNode("2829-dyn-string-starts-with-missing-search.cjs", "true\n");
});
