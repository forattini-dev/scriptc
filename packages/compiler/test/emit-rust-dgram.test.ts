import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Rust dgram send validation and connected state match Node byte-for-byte", async () => {
  const fixture = resolve("tests/corpus/2597-dgram-send-ladders.cjs");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dgram-"));
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
});

test("Rust UDP sockets exchange datagrams and preserve close ordering", async () => {
  const fixture = resolve("tests/fixtures/dgram/cases/udp-loopback-pair/main.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dgram-roundtrip-"));
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
    execFileAsync(process.execPath, ["--no-warnings", fixture], options),
    execFileAsync(result.binaryPath, [], {
      ...options,
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
