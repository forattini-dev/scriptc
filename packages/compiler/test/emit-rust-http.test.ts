import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test.each([
  "1543-set-server-handles.ts",
  "1750-http-agent-options.ts",
  "1781-http-server-shapes.cjs",
  "2644-http-client-url-argument.ts",
  "2672-http-request-response-callback.ts",
  "2696-http-server-net-roundtrip.ts",
  "2689-http-server-timeout-properties.ts",
  "2801-http-server-max-header-size.ts",
  "2802-http-server-max-header-size-range.ts",
  "2803-http-server-max-header-size-undefined.ts",
  "2804-http-server-max-header-size-zero.ts",
  "2805-http-server-option-evaluation-order.ts",
])("Rust HTTP corpus matches Node: %s", async (fixtureName) => {
  const fixture = resolve("tests/corpus", fixtureName);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-http-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, fixtureName.replace(/\.[^.]+$/, "")),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const node = await execFileAsync(nodeOracleExecutable(), [fixture]);
  const rust = await execFileAsync(result.binaryPath, [], {
    env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
  });
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
