import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test.each([
  "1443-signal-handlers.ts",
  "1469-remove-listener.ts",
])("Rust process signal listeners match Node: %s", async (fixture) => {
  const entry = resolve("tests/corpus", fixture);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-signals-"));
  const result = await compile(entry, {
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
    execFileAsync(process.execPath, [entry]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
