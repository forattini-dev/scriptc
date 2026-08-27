import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function expectFsDifferential(relativePath: string): Promise<void> {
  const fixture = resolve(relativePath);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-fs-checked-"));
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
    execFileAsync(process.execPath, [fixture]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}

test("Rust filesystem argument ladders match Node byte-for-byte", async () =>
  expectFsDifferential("tests/corpus/2595-fs-arg-ladders.cjs"));

test("Rust fs.rename checkJs callback receives Error or null", async () =>
  expectFsDifferential("tests/corpus/2683-fs-rename-js.cjs"));
