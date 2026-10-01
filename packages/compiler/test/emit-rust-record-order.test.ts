import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test.each([
  "3330-record-instance-key-order.ts",
  "3331-record-instance-iteration-order.ts",
  "3332-record-order-spread-aliasing.ts",
])("Rust compiles per-instance order regression %s without an engine", async name => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-instance-order-"));
  try {
    const result = await compile(resolve("tests/corpus", name), {
      backend: "rust", allowEngine: false,
      outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    expect(result.runtimeFences).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Rust retained record lowering preserves declaration order", async () => {
  const fixture = resolve("tests/corpus/2691-retained-lowering-record-order.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-record-order-"));
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
    execFileAsync(nodeOracleExecutable(), [fixture]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
