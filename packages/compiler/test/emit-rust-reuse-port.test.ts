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
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-reuse-port-"));
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
    execFileAsync(nodeOracleExecutable(), [fixture], { timeout: 10_000 }),
    execFileAsync(result.binaryPath, [], {
      timeout: 10_000,
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(node.stdout).toBe(expectedStdout);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}

test.runIf(process.platform === "linux")("Rust shares a TCP port when reusePort is true", async () => {
  await expectRustToMatchNode("2831-net-reuse-port.ts", "shared true\n");
});

test.runIf(process.platform === "linux")("Rust isolates IPv6 binds when ipv6Only is true", async () => {
  await expectRustToMatchNode("2832-net-ipv6-only.ts", "split true\n");
});

test("Rust accepts listen options with an omitted host", async () => {
  await expectRustToMatchNode("2833-net-listen-options-default-host.ts", "listening true\n");
});
