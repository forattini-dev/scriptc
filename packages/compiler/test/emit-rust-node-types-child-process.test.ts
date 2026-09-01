import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Rust lowers @types/node ChildProcessByStdio and matches Node", async () => {
  const fixture = resolve("tests/fixtures/node-types/child-process-by-stdio.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-node-child-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "child-process-by-stdio"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const env = { ...process.env, NODE_NO_WARNINGS: "1" };
  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [fixture], { env }),
    execFileAsync(result.binaryPath, [], {
      env: { ...env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
