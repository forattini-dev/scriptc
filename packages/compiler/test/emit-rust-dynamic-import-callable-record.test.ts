import { execFile } from "node:child_process";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Rust calls an async method through a checked dynamic module interface", async () => {
  const fixtures = resolve("tests/fixtures/island-modules");
  const entry = join(fixtures, "computed-callable-record.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-callable-record-"));
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    dynamic: true,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? entry : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  await copyFile(join(fixtures, "computed-core.mjs"), join(dir, "computed-core.mjs"));
  const env = { ...process.env, NODE_NO_WARNINGS: "1" };
  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [entry], { env }),
    execFileAsync(result.binaryPath, [], {
      env: { ...env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
  expect(rust.stdout).toBe("12\n");
});

test("Rust calls mixed async and sync methods through a checked dynamic module interface", async () => {
  const fixtures = resolve("tests/fixtures/island-modules");
  const entry = join(fixtures, "computed-mixed-callable-record.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-mixed-callable-record-"));
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    dynamic: true,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? entry : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  await copyFile(join(fixtures, "computed-core.mjs"), join(dir, "computed-core.mjs"));
  const env = { ...process.env, NODE_NO_WARNINGS: "1" };
  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [entry], { env }),
    execFileAsync(result.binaryPath, [], {
      env: { ...env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
  expect(rust.stdout).toBe("12\nout:build:auto\n17:boom\n");
});
